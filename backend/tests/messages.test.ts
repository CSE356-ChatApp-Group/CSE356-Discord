/**
 * Messages & overload-protection integration tests.
 */

import { randomUUID } from 'crypto';
import { request, app, wsServer, pool, redis, closeRedisConnections } from './runtime';

import { uniqueSuffix, createAuthenticatedUser } from './helpers';

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

// ── Overload protection ───────────────────────────────────────────────────────

describe('POST /messages idempotency', () => {
  it('returns the same message id when retrying with the same Idempotency-Key', async () => {
    const owner = await createAuthenticatedUser('idemretry');
    const slug = `idem-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'idempotency' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `idem-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const idemKey = `idem-${uniqueSuffix()}`;
    const body = { channelId, content: 'idempotent body' };
    const r1 = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('Idempotency-Key', idemKey)
      .send(body);
    expect(r1.status).toBe(201);
    const id1 = r1.body.message.id;
    expect(r1.body.realtimeFanoutComplete).toBe(true);
    expect(typeof r1.body.realtimePublishedAt).toBe('string');

    const r2 = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('Idempotency-Key', idemKey)
      .send(body);
    expect(r2.status).toBe(201);
    expect(r2.body.message.id).toBe(id1);
    expect(r2.body.realtimeFanoutComplete).toBe(true);
    expect(typeof r2.body.realtimePublishedAt).toBe('string');
  });

  it('concurrent POSTs with the same Idempotency-Key resolve to one message', async () => {
    const owner = await createAuthenticatedUser('idemconc');
    const slug = `idemc-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'idempotency concurrent' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `idemc-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const idemKey = `idem-conc-${uniqueSuffix()}`;
    const body = { channelId, content: 'concurrent idempotent' };
    const [a, b] = await Promise.all([
      request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .set('Idempotency-Key', idemKey)
        .send(body),
      request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .set('Idempotency-Key', idemKey)
        .send(body),
    ]);

    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
    expect(a.status === 201 || b.status === 201).toBe(true);
    const okBodies = [a, b].filter((r) => r.status === 201);
    const msgIds = okBodies.map((r) => r.body.message.id);
    expect(new Set(msgIds).size).toBe(1);

    const list = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=30`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    const withBody = (list.body.messages || []).filter(
      (m: { content?: string }) => m.content === 'concurrent idempotent',
    );
    expect(withBody.length).toBe(1);
  });
});

describe('GET /messages first-page cache vs POST', () => {
  it('does not serve stale Redis first-page cache after POST /messages', async () => {
    const owner = await createAuthenticatedUser('cachebust');
    const slug = `cachebust-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'cache bust' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `cb-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const cacheKey = `messages:channel:${channelId}`;
    await redis.set(cacheKey, JSON.stringify({ messages: [] }), 'EX', 15);

    const postRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, content: 'after stale seed' });

    expect(postRes.status).toBe(201);
    const messageId = postRes.body.message.id;

    const getRes = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=30`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(getRes.status).toBe(200);
    const ids = (getRes.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).toContain(messageId);
  });

  it('does not mix cached payloads across different first-page limits', async () => {
    const owner = await createAuthenticatedUser('cachelimitmix');
    const slug = `cachelimitmix-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'cache limit mix' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `clm-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    for (let i = 0; i < 8; i += 1) {
      const postRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: `limit-mix-${i}-${uniqueSuffix()}` });
      expect(postRes.status).toBe(201);
    }

    const small = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=1`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(small.status).toBe(200);
    expect(Array.isArray(small.body.messages)).toBe(true);
    expect(small.body.messages.length).toBe(1);

    const large = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=7`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(large.status).toBe(200);
    expect(Array.isArray(large.body.messages)).toBe(true);
    expect(large.body.messages.length).toBe(7);
  });
});

describe('GET /messages channel id as conversationId (generated-client compatibility)', () => {
  it('returns channel history when only conversationId= is set to the channel UUID', async () => {
    const owner = await createAuthenticatedUser('convparamchan');
    const slug = `cpc-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'conv param channel' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `cpc-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const postRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, content: 'msg-via-conversationId-query' });
    expect(postRes.status).toBe(201);
    const messageId = postRes.body.message.id;

    const getRes = await request(app)
      .get(`/api/v1/messages?conversationId=${channelId}&limit=30`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(getRes.status).toBe(200);
    const ids = (getRes.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).toContain(messageId);
  });

  it('matches channelId pagination when only conversationId= names the channel', async () => {
    const owner = await createAuthenticatedUser('convparampage');
    const slug = `cpp-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'conv param page' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `cpp-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const msgIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const postRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: `page-${i}-${uniqueSuffix()}` });
      expect(postRes.status).toBe(201);
      msgIds.push(postRes.body.message.id);
    }
    const [id1, id2, id3] = msgIds;

    const viaConv = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .query({ conversationId: channelId, before: id3, limit: 10 });
    const viaChan = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .query({ channelId, before: id3, limit: 10 });

    expect(viaConv.status).toBe(200);
    expect(viaChan.status).toBe(200);
    const convPage = (viaConv.body.messages || []).map((m: { id: string }) => m.id);
    const chanPage = (viaChan.body.messages || []).map((m: { id: string }) => m.id);
    expect(convPage).toEqual(chanPage);
    expect(convPage).toContain(id1);
    expect(convPage).toContain(id2);
  });

  it('lets a private-channel member load history with conversationId= only', async () => {
    const owner = await createAuthenticatedUser('convparamprivown');
    const member = await createAuthenticatedUser('convparamprivmem');
    const slug = `cppriv-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'priv conv param' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(joinRes.status).toBe(200);

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `priv-ch-${uniqueSuffix()}`.slice(0, 32), isPrivate: true });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const addRes = await request(app)
      .post(`/api/v1/channels/${channelId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userIds: [member.user.id] });
    expect(addRes.status).toBe(200);

    const postRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, content: 'private-via-conversationId-query' });
    expect(postRes.status).toBe(201);
    const messageId = postRes.body.message.id;

    const getRes = await request(app)
      .get(`/api/v1/messages?conversationId=${channelId}&limit=30`)
      .set('Authorization', `Bearer ${member.accessToken}`);

    expect(getRes.status).toBe(200);
    const ids = (getRes.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).toContain(messageId);
  });

  it('returns 403 when conversationId is a private channel UUID and user is not a member', async () => {
    const owner = await createAuthenticatedUser('convparam403own');
    const stranger = await createAuthenticatedUser('convparam403str');
    const slug = `cp403-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: '403 conv param' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `priv403-${uniqueSuffix()}`.slice(0, 32), isPrivate: true });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const getRes = await request(app)
      .get(`/api/v1/messages?conversationId=${channelId}&limit=30`)
      .set('Authorization', `Bearer ${stranger.accessToken}`);

    expect(getRes.status).toBe(403);
  });
});

describe('Overload behavior', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('overloadowner');
    token = owner.accessToken;

    const slug = `loadtest-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug, name: slug, description: 'overload test community' });
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ communityId, name: `overload-${uniqueSuffix()}`.slice(0, 32), isPrivate: false, description: 'overload channel' });
    channelId = channelRes.body.channel.id;
  });

  afterEach(() => {
    delete process.env.FORCE_OVERLOAD_STAGE;
  });

  it('keeps core message create path available under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: 'core path should still work' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.content).toBe('core path should still work');
  });

  it('rejects message edit under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .patch(`/api/v1/messages/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'updated' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });

  it('rejects message delete under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .delete(`/api/v1/messages/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });

  it('rejects read-state write under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .put(`/api/v1/messages/${randomUUID()}/read`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily delayed/i);
  });

  it('rejects search at critical stage before query execution', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .get('/api/v1/search')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });
});

// ── Message hydration payloads ────────────────────────────────────────────────

describe('Message hydration payloads', () => {
  let token: string;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('hydrationowner');
    token = owner.accessToken;
    userId = owner.user.id;

    const slug = `hydration-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug, name: slug, description: 'hydration test community' });
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ communityId, name: `hydration-${uniqueSuffix()}`.slice(0, 32), isPrivate: false, description: 'hydration channel' });
    channelId = channelRes.body.channel.id;
  });

  it('rejects message create when both channelId and conversationId are set', async () => {
    const res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        channelId,
        conversationId: '00000000-0000-4000-8000-000000000001',
        content: 'both targets',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only one of channelId or conversationId/i);
  });

  it('returns hydrated author and attachments on message create', async () => {
    const res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: 'hydrated create payload' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.author).toBeDefined();
    expect(res.body.message.author.id).toBe(userId);
    expect(Array.isArray(res.body.message.attachments)).toBe(true);
  });

  it('returns hydrated author and attachments on message update', async () => {
    const createRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: 'before edit' });

    const messageId = createRes.body.message.id;

    const res = await request(app)
      .patch(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'after edit' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.content).toBe('after edit');
    expect(res.body.message.author).toBeDefined();
    expect(res.body.message.author.id).toBe(userId);
    expect(Array.isArray(res.body.message.attachments)).toBe(true);
  });
});

describe('Hard delete contract', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('harddeleteowner');
    token = owner.accessToken;

    const slug = `harddelete-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug, name: slug, description: 'hard delete contract community' });
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({
        communityId,
        name: `hard-delete-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: false,
        description: 'hard delete channel',
      });
    channelId = channelRes.body.channel.id;
  });

  it('removes deleted messages from storage and message history', async () => {
    const createRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: `delete-target-${uniqueSuffix()}` });

    expect(createRes.status).toBe(201);
    const messageId = createRes.body.message.id;

    const deleteRes = await request(app)
      .delete(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(200);

    const dbRes = await pool.query(
      'SELECT id FROM messages WHERE id = $1',
      [messageId],
    );
    expect(dbRes.rows).toHaveLength(0);

    const listRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .query({ channelId });

    expect(listRes.status).toBe(200);
    const ids = (listRes.body.messages || []).map((message: any) => message.id);
    expect(ids).not.toContain(messageId);
  });

  it('returns 404 when deleting an already-deleted message id', async () => {
    const createRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: `delete-once-${uniqueSuffix()}` });

    expect(createRes.status).toBe(201);
    const messageId = createRes.body.message.id;

    const firstDelete = await request(app)
      .delete(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(firstDelete.status).toBe(200);

    const secondDelete = await request(app)
      .delete(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(secondDelete.status).toBe(404);
  });

  it('deletes a thread parent without 500 when replies exist (thread_id cleared on FK)', async () => {
    const parentRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: `thread-root-${uniqueSuffix()}` });
    expect(parentRes.status).toBe(201);
    const parentId = parentRes.body.message.id;

    const replyRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        channelId,
        content: `thread-reply-${uniqueSuffix()}`,
        threadId: parentId,
      });
    expect(replyRes.status).toBe(201);
    const replyId = replyRes.body.message.id;

    const delParent = await request(app)
      .delete(`/api/v1/messages/${parentId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(delParent.status).toBe(200);

    const replyRow = await pool.query('SELECT thread_id FROM messages WHERE id = $1', [replyId]);
    expect(replyRow.rows[0].thread_id).toBeNull();

    const parentRow = await pool.query('SELECT id FROM messages WHERE id = $1', [parentId]);
    expect(parentRow.rows).toHaveLength(0);
  });

  it('concurrent hard-deletes in the same channel all succeed (last_message repoint race)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const createRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ channelId, content: `conc-del-${i}-${uniqueSuffix()}` });
      expect(createRes.status).toBe(201);
      ids.push(createRes.body.message.id);
    }

    const deletes = await Promise.all(
      ids.map((messageId) =>
        request(app)
          .delete(`/api/v1/messages/${messageId}`)
          .set('Authorization', `Bearer ${token}`),
      ),
    );

    expect(deletes.every((r) => r.status === 200)).toBe(true);
  });
});

describe('Message context window', () => {
  let ownerToken: string;
  let outsiderToken: string;
  let channelId: string;
  let messageIds: string[] = [];

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('contextowner');
    ownerToken = owner.accessToken;

    const outsider = await createAuthenticatedUser('contextoutsider');
    outsiderToken = outsider.accessToken;

    const slug = `context-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug, name: slug, description: 'message context community' });
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        communityId,
        name: `context-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: true,
        description: 'message context channel',
      });
    channelId = channelRes.body.channel.id;

    messageIds = [];
    for (let index = 0; index < 5; index += 1) {
      const createRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ channelId, content: `context message ${index}` });
      messageIds.push(createRes.body.message.id);
    }
  });

  it('returns a bounded chronological window around the target message', async () => {
    const targetId = messageIds[2];

    const res = await request(app)
      .get(`/api/v1/messages/context/${targetId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .query({ limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.targetMessageId).toBe(targetId);
    expect(res.body.channelId).toBe(channelId);
    expect(res.body.messages.map((message: any) => message.id)).toEqual(messageIds);
    expect(res.body.messages[2].id).toBe(targetId);
  });

  it('pages newer history after an anchor message in chronological order', async () => {
    const res = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .query({ channelId, after: messageIds[2], limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.messages.map((message: any) => message.id)).toEqual([messageIds[3], messageIds[4]]);
  });

  it('returns 403 when the requester cannot access the target message', async () => {
    const res = await request(app)
      .get(`/api/v1/messages/context/${messageIds[2]}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .query({ limit: 2 });

    expect(res.status).toBe(403);
  });
});

describe('GET /messages latest-page cache vs POST', () => {
  it('channel latest GET includes a message immediately after POST (cache bust)', async () => {
    const owner = await createAuthenticatedUser('cachebustch');
    const token = owner.accessToken;

    const slug = `cachebust-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug, name: slug, description: 'cache bust channel' });
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({
        communityId,
        name: `cacheb-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: false,
        description: 'cache bust',
      });
    const channelId = channelRes.body.channel.id;

    const warm = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=50`)
      .set('Authorization', `Bearer ${token}`);
    expect(warm.status).toBe(200);

    const postRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: ' right after warm cache ' });
    expect(postRes.status).toBe(201);
    const newId = postRes.body.message.id;

    const after = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=50`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    const ids = (after.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).toContain(newId);
  });

  it('conversation latest GET includes a message immediately after POST (cache bust)', async () => {
    const a = await createAuthenticatedUser('cachebusta');
    const b = await createAuthenticatedUser('cachebustb');

    const openRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.user.id] });
    expect(openRes.status).toBe(201);
    const conversationId = openRes.body.conversation.id;

    const warmB = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(warmB.status).toBe(200);

    const postRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ conversationId, content: 'dm cache bust from a' });
    expect(postRes.status).toBe(201);
    const newId = postRes.body.message.id;

    const afterB = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(afterB.status).toBe(200);
    const ids = (afterB.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).toContain(newId);
  });
});

describe('GET /messages latest-page cache vs DELETE', () => {
  it('conversation latest GET omits a deleted message immediately (cache bust)', async () => {
    const a = await createAuthenticatedUser('delcachea');
    const b = await createAuthenticatedUser('delcacheb');

    const openRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.user.id] });
    expect(openRes.status).toBe(201);
    const conversationId = openRes.body.conversation.id;

    const m1Res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ conversationId, content: 'dm first' });
    expect(m1Res.status).toBe(201);
    const m1Id = m1Res.body.message.id;

    const m2Res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ conversationId, content: 'dm to delete' });
    expect(m2Res.status).toBe(201);
    const m2Id = m2Res.body.message.id;

    const warmB = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(warmB.status).toBe(200);
    const warmIds = (warmB.body.messages || []).map((m: { id: string }) => m.id);
    expect(warmIds).toContain(m2Id);

    await redis.set(
      `messages:conversation:${conversationId}`,
      JSON.stringify(warmB.body),
      'EX',
      60,
    );

    const delRes = await request(app)
      .delete(`/api/v1/messages/${m2Id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(delRes.status).toBe(200);

    const afterB = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(afterB.status).toBe(200);
    const ids = (afterB.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).not.toContain(m2Id);
    expect(ids).toContain(m1Id);
  });
});

describe('GET /messages latest-page cache vs DELETE (channel)', () => {
  it('channel latest GET omits a deleted message immediately even with stale Redis seed', async () => {
    const owner = await createAuthenticatedUser('chandelcache');
    const slug = `chandel-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'channel delete cache' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const chanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId,
        name: `chandel-ch-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: false,
      });
    expect(chanRes.status).toBe(201);
    const channelId = chanRes.body.channel.id;

    const m1Res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, content: 'ch first' });
    expect(m1Res.status).toBe(201);
    const m1Id = m1Res.body.message.id;

    const m2Res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, content: 'ch delete me' });
    expect(m2Res.status).toBe(201);
    const m2Id = m2Res.body.message.id;

    const warm = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=50`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(warm.status).toBe(200);

    await redis.set(
      `messages:channel:${channelId}`,
      JSON.stringify(warm.body),
      'EX',
      60,
    );

    const delRes = await request(app)
      .delete(`/api/v1/messages/${m2Id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(delRes.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=50`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(after.status).toBe(200);
    const ids = (after.body.messages || []).map((m: { id: string }) => m.id);
    expect(ids).not.toContain(m2Id);
    expect(ids).toContain(m1Id);
  });
});

describe('GET /messages latest-page cache vs group DM system rows', () => {
  it('includes join system message immediately after invite (cache bust)', async () => {
    const a = await createAuthenticatedUser('grpsysinvitea');
    const b = await createAuthenticatedUser('grpsysinviteb');
    const c = await createAuthenticatedUser('grpsysinvited');
    const d = await createAuthenticatedUser('grpsysinvitebase');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.user.id, d.user.id] });
    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const warm = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(warm.status).toBe(200);

    // Stale first-page cache must not win over a follow-up GET after invite (grader-style race).
    await redis.set(
      `messages:conversation:${conversationId}`,
      JSON.stringify(warm.body),
      'EX',
      60,
    );

    const inviteRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/invite`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [c.user.id] });
    expect(inviteRes.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(after.status).toBe(200);
    expect(
      after.body.messages.some(
        (m: { type?: string; content?: string }) =>
          m.type === 'system' && /joined the group/i.test(m.content || ''),
      ),
    ).toBe(true);
  });

  it('includes leave system message immediately after member leaves (cache bust)', async () => {
    const a = await createAuthenticatedUser('grpsysleavea');
    const b = await createAuthenticatedUser('grpsysleaveb');
    const d = await createAuthenticatedUser('grpsysleaved');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.user.id, d.user.id] });
    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const warm = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(warm.status).toBe(200);

    await redis.set(
      `messages:conversation:${conversationId}`,
      JSON.stringify(warm.body),
      'EX',
      60,
    );

    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(leaveRes.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/messages?conversationId=${conversationId}&limit=50`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(after.status).toBe(200);
    expect(
      after.body.messages.some(
        (m: { type?: string; content?: string }) =>
          m.type === 'system' && /left the group/i.test(m.content || ''),
      ),
    ).toBe(true);
  });
});

describe('Channel community-membership enforcement', () => {
  it('rejects reading or posting in a public channel when the user is not in the community', async () => {
    const owner = await createAuthenticatedUser('publicchannelowner');
    const outsider = await createAuthenticatedUser('publicchanneloutsider');
    const slug = `public-channel-${uniqueSuffix()}`;

    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'public channel access control' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `pub-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(channelRes.status).toBe(201);
    const channelId = channelRes.body.channel.id;

    const postOwnerRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId, content: 'owner message in public channel' });
    expect(postOwnerRes.status).toBe(201);

    const outsiderGetRes = await request(app)
      .get(`/api/v1/messages?channelId=${channelId}&limit=50`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(outsiderGetRes.status).toBe(403);

    const outsiderPostRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ channelId, content: 'outsider should not post' });
    expect(outsiderPostRes.status).toBe(403);
  });
});
