/**
 * Messages & overload-protection integration tests.
 */

import { randomUUID } from 'crypto';
import { request, app, wsServer, pool, closeRedisConnections } from './runtime';

import { uniqueSuffix, createAuthenticatedUser } from './helpers';

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

// ── Overload protection ───────────────────────────────────────────────────────

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
});
