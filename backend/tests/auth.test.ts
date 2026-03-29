/**
 * Auth route integration tests.
 */

import { request, app, wsServer, pool, closeRedisConnections } from './runtime';

import { uniqueSuffix, registerUser } from './helpers';

beforeAll(async () => {
  await pool.query("DELETE FROM users WHERE email = 'test@example.com'");
});

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

// ── Register ────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  it('creates a new user and returns an access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'test@example.com',
        username: 'testuser',
        password: 'Password1!',
        displayName: 'Test User',
      });

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

  it('accepts hyphenated usernames and returns conflict on duplicate registration', async () => {
    const suffix = uniqueSuffix();
    const email = `hyphen-${suffix}@example.com`;
    const username = `abiding-aardwark-${suffix}`.slice(0, 32);

    const first = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, username, password: 'Password1!' });

    expect(first.status).toBe(201);
    expect(first.body.user.username).toBe(username);

    const duplicate = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, username, password: 'Password1!' });

    expect(duplicate.status).toBe(409);
  });
});

// ── Login ────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login', () => {
  it('returns access token for valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});

// ── /users/me ───────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/users/me', () => {
  let token: string;

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
