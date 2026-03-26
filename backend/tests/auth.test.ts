/**
 * Auth route tests
 *
 * Run with: npm test
 * Requires a live Postgres and Redis (provided by docker-compose or the CI service config).
 */

'use strict';

const request = require('supertest');
const { randomUUID } = require('crypto');
const app     = require('../src/app');
const { pool }= require('../src/db/pool');
const { closeRedisConnections } = require('../src/db/redis');

beforeAll(async () => {
  // Ensure test user doesn't exist
  await pool.query("DELETE FROM users WHERE email = 'test@example.com'");
});

afterAll(async () => {
  await closeRedisConnections();
  await pool.end();
});

describe('POST /api/v1/auth/register', () => {
  it('creates a new user and returns an access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', username: 'testuser', password: 'Password1!', displayName: 'Test User' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
  });

  it('rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', username: 'testuser2', password: 'Password1!' });

    expect(res.status).toBe(409);
  });

  it('rejects weak passwords', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'other@example.com', username: 'other', password: '123' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns access token for valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    // refresh cookie should be set
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/users/me', () => {
  let token;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });
    token = res.body.accessToken;
  });

  it('returns own profile when authenticated', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('testuser');
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});

describe('Overload behavior', () => {
  let token;
  let userId;
  let channelId;

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });

    token = loginRes.body.accessToken;

    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      ['test@example.com']
    );
    userId = userRows[0].id;

    const slug = `loadtest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const { rows: communityRows } = await pool.query(
      `INSERT INTO communities (slug, name, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [slug, 'Load Test Community', userId]
    );
    const communityId = communityRows[0].id;

    await pool.query(
      `INSERT INTO community_members (community_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [communityId, userId]
    );

    const { rows: channelRows } = await pool.query(
      `INSERT INTO channels (community_id, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [communityId, `general-${Math.floor(Math.random() * 10000)}`, userId]
    );
    channelId = channelRows[0].id;
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
