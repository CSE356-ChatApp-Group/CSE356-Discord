/**
 * Auth route tests
 *
 * Run with: npm test
 * Requires a live Postgres and Redis (provided by docker-compose or the CI service config).
 */

'use strict';

const request = require('supertest');
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
