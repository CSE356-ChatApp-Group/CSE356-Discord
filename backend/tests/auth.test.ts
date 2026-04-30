/**
 * Auth route integration tests.
 */

import { request, app, pool } from './runtime';

import { uniqueSuffix, registerUser } from './helpers';

beforeAll(async () => {
  await pool.query("DELETE FROM users WHERE email = 'test@example.com'");
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
    expect(res.body.user.displayName).toBe('Test User');
  });

  it('rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', username: 'testuser2', password: 'Password1!' });

    expect(res.status).toBe(409);
  });

  it('allows short passwords', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'other@example.com', username: 'other', password: '123' });

    expect(res.status).toBe(201);
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

  it('registers successfully without an email address', async () => {
    const suffix = uniqueSuffix();
    const username = `noemail${suffix}`.slice(0, 32);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'Password1!' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.email).toBeFalsy();
    expect(res.body.user.username).toBe(username);
  });

  it('allows any non-empty email string when one is supplied', async () => {
    const suffix = uniqueSuffix();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', username: `badmail${suffix}`, password: 'Password1!' });

    expect(res.status).toBe(201);
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
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });

  it('logs in using username instead of email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'testuser', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('allows a no-email user to register and then log in by username', async () => {
    const suffix = uniqueSuffix();
    const username = `nologin${suffix}`.slice(0, 32);

    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ username, password: 'Password1!' });
    expect(reg.status).toBe(201);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: username, password: 'Password1!' });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeDefined();
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
