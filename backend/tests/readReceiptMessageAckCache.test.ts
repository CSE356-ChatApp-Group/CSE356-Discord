/**
 * Redis-backed duplicate read receipt ack fast path (READ_RECEIPT_MESSAGE_ACK_CACHE_*).
 *
 * Integration cases need Postgres + Redis. Prefer the repo test runner (provisions Docker
 * `chatapp_test` + Redis) instead of raw `npx jest` when your environment sets `DATABASE_URL`
 * to a non-test database (e.g. missing default db named after the OS user):
 *
 *   cd backend && env -u DATABASE_URL -u READ_REPLICA_URL TEST_FORCE_PROVISION=1 \
 *     node scripts/test-runner.cjs readReceiptMessageAckCache.test.ts --runInBand
 *
 * Or: `npm run test:docker -- readReceiptMessageAckCache.test.ts --runInBand`
 */

import { request, app, redis } from './runtime';
import { createAuthenticatedUser, createCommunityChannelFixture, postMessage } from './helpers';
const {
  readReceiptMessageAckCacheTotal,
  readReceiptNoopSkipTotal,
} = require('../src/utils/metrics/messageWritePath');

const { readReceiptMessageAckRedisKey } = require('../src/messages/readReceipt/readReceiptMessageAckCache');
const {
  markMessageInsertUnhealthyForReadShedding,
  resetMessageInsertHealthForTests,
} = require('../src/messages/messageInsertHealth');

function counterValueByLabels(counter: any, labels: Record<string, string>) {
  const rows = counter?.hashMap ? Object.values(counter.hashMap as Record<string, any>) : [];
  for (const row of rows as any[]) {
    const rowLabels = row?.labels || {};
    const matches = Object.entries(labels).every(([k, v]) => String(rowLabels[k]) === String(v));
    if (matches) return Number(row?.value || 0);
  }
  return 0;
}

describe('readReceiptMessageAckCache', () => {
  const prevEnabled = process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
  const prevTtl = process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS;

  afterEach(() => {
    jest.restoreAllMocks();
    if (prevEnabled === undefined) delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
    else process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED = prevEnabled;
    if (prevTtl === undefined) delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS;
    else process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS = prevTtl;
    resetMessageInsertHealthForTests();
  });

  describe('HTTP + Redis integration', () => {
    beforeEach(() => {
      process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED = 'true';
      process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS = '120000';
    });

    it('first read miss then set; second read hits ack cache and skips heavy path', async () => {
      const owner = await createAuthenticatedUser('ackcache1');
      const { channelId } = await createCommunityChannelFixture(owner.accessToken, {
        slugPrefix: 'ackc1',
        channelPrefix: 'ackc1-ch',
        description: 'ack cache',
      });
      const postRes = await postMessage(owner.accessToken, { channelId, content: 'ack body' });
      expect(postRes.status).toBe(201);
      const messageId = postRes.body.message.id;
      const ackKey = readReceiptMessageAckRedisKey(owner.user.id, messageId);
      await redis.del(ackKey).catch(() => {});

      const missBefore = counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'miss' });
      const hitBefore = counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'hit' });
      const noopBefore = counterValueByLabels(readReceiptNoopSkipTotal, {
        reason: 'redis_message_ack_cache',
      });

      const r1 = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(r1.status).toBe(200);
      expect(r1.body).toEqual({ success: true });

      expect(counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'miss' })).toBeGreaterThanOrEqual(
        missBefore + 1,
      );
      expect(counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'set_ok' })).toBeGreaterThanOrEqual(1);

      const exists = await redis.get(ackKey);
      expect(exists).toBe('1');

      // Past in-proc same-message coalesce window so the second request exercises Redis ack, not hasConfirmedRecentMessageRead.
      await new Promise((r) => setTimeout(r, 550));

      const r2 = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(r2.status).toBe(200);
      expect(r2.body).toEqual({ success: true });

      expect(counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'hit' })).toBeGreaterThanOrEqual(
        hitBefore + 1,
      );
      expect(counterValueByLabels(readReceiptNoopSkipTotal, { reason: 'redis_message_ack_cache' })).toBeGreaterThanOrEqual(
        noopBefore + 1,
      );
    });

    it('does not set ack on 403', async () => {
      const owner = await createAuthenticatedUser('ack403a');
      const stranger = await createAuthenticatedUser('ack403b');
      const { channelId } = await createCommunityChannelFixture(owner.accessToken, {
        slugPrefix: 'ack403',
        channelPrefix: 'ack403-ch',
        description: 'ack 403',
      });
      const postRes = await postMessage(owner.accessToken, { channelId, content: 'private read' });
      expect(postRes.status).toBe(201);
      const messageId = postRes.body.message.id;
      const ackKey = readReceiptMessageAckRedisKey(stranger.user.id, messageId);
      await redis.del(ackKey).catch(() => {});

      const res = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({});
      expect(res.status).toBe(403);
      const v = await redis.get(ackKey);
      expect(v).toBeNull();
    });

    it('does not set ack on 404', async () => {
      const owner = await createAuthenticatedUser('ack404');
      const fakeId = '00000000-0000-4000-8000-000000000001';
      const ackKey = readReceiptMessageAckRedisKey(owner.user.id, fakeId);
      await redis.del(ackKey).catch(() => {});

      const res = await request(app)
        .put(`/api/v1/messages/${fakeId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(res.status).toBe(404);
      const v = await redis.get(ackKey);
      expect(v).toBeNull();
    });

    it('does not set ack on preflight deferred message_insert_unhealthy', async () => {
      const owner = await createAuthenticatedUser('ackdef');
      const { channelId } = await createCommunityChannelFixture(owner.accessToken, {
        slugPrefix: 'ackdef',
        channelPrefix: 'ackdef-ch',
        description: 'ack defer',
      });
      const postRes = await postMessage(owner.accessToken, { channelId, content: 'defer body' });
      expect(postRes.status).toBe(201);
      const messageId = postRes.body.message.id;
      const ackKey = readReceiptMessageAckRedisKey(owner.user.id, messageId);
      await redis.del(ackKey).catch(() => {});

      markMessageInsertUnhealthyForReadShedding();
      const deferRes = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(deferRes.status).toBe(200);
      expect(deferRes.body.deferred).toBe(true);
      expect(deferRes.body.reason).toBe('message_insert_unhealthy');

      const v = await redis.get(ackKey);
      expect(v).toBeNull();
    });

    it('Redis GET error fails open and still completes read', async () => {
      const owner = await createAuthenticatedUser('ackgeterr');
      const { channelId } = await createCommunityChannelFixture(owner.accessToken, {
        slugPrefix: 'ackge',
        channelPrefix: 'ackge-ch',
        description: 'ack get err',
      });
      const postRes = await postMessage(owner.accessToken, { channelId, content: 'get err' });
      expect(postRes.status).toBe(201);
      const messageId = postRes.body.message.id;
      const spy = jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated redis get failure'));

      const errBefore = counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'get_error' });
      const res = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'get_error' })).toBeGreaterThanOrEqual(
        errBefore + 1,
      );
      spy.mockRestore();
    });

    it('Redis SET error does not fail the HTTP response', async () => {
      const owner = await createAuthenticatedUser('ackseterr');
      const { channelId } = await createCommunityChannelFixture(owner.accessToken, {
        slugPrefix: 'ackse',
        channelPrefix: 'ackse-ch',
        description: 'ack set err',
      });
      const postRes = await postMessage(owner.accessToken, { channelId, content: 'set err' });
      expect(postRes.status).toBe(201);
      const messageId = postRes.body.message.id;
      const ackKey = readReceiptMessageAckRedisKey(owner.user.id, messageId);
      await redis.del(ackKey).catch(() => {});

      // Reject only read-receipt ack keys: other Redis SETs (e.g. channel:msg_count reconcile) run on the same path.
      const origSet = redis.set.bind(redis);
      const setSpy = jest.spyOn(redis, 'set').mockImplementation((key: unknown, ...rest: unknown[]) => {
        if (typeof key === 'string' && key.startsWith('read_receipt_msg_ack:')) {
          return Promise.reject(new Error('simulated ack set failure'));
        }
        return origSet(key as string, ...(rest as any[]));
      });
      const errBefore = counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'set_error' });

      const r1 = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(r1.status).toBe(200);
      expect(r1.body).toEqual({ success: true });
      expect(counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'set_error' })).toBeGreaterThanOrEqual(
        errBefore + 1,
      );
      setSpy.mockRestore();

      await new Promise((r) => setTimeout(r, 550));
      const missBefore = counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'miss' });
      const r2 = await request(app)
        .put(`/api/v1/messages/${messageId}/read`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({});
      expect(r2.status).toBe(200);
      expect(counterValueByLabels(readReceiptMessageAckCacheTotal, { result: 'miss' })).toBeGreaterThanOrEqual(
        missBefore + 1,
      );
    });

    it('feature flag disabled skips ack path (no redis_message_ack_cache noop)', async () => {
      delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
      const owner = await createAuthenticatedUser('ackoff');
      const { channelId } = await createCommunityChannelFixture(owner.accessToken, {
        slugPrefix: 'ackoff',
        channelPrefix: 'ackoff-ch',
        description: 'ack off',
      });
      const postRes = await postMessage(owner.accessToken, { channelId, content: 'off path' });
      expect(postRes.status).toBe(201);
      const messageId = postRes.body.message.id;
      const noopBefore = counterValueByLabels(readReceiptNoopSkipTotal, {
        reason: 'redis_message_ack_cache',
      });

      for (let i = 0; i < 2; i += 1) {
        const res = await request(app)
          .put(`/api/v1/messages/${messageId}/read`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({});
        expect(res.status).toBe(200);
      }
      expect(counterValueByLabels(readReceiptNoopSkipTotal, { reason: 'redis_message_ack_cache' })).toBe(noopBefore);
    });
  });
});
