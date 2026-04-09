/**
 * Course OIDC callback: ensure first-time sign-in uses the pending (create vs connect)
 * flow instead of auto-provisioning, and returning users with a linked row get tokens.
 */

import { request, app, wsServer, pool, closeRedisConnections } from './runtime';
import { createAuthenticatedUser, uniqueSuffix } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signOAuthLinkIntent, verifyOAuthPending } = require('../src/auth/oauthTokens');

function makeState() {
  return signOAuthLinkIntent({
    purpose: 'course-login',
    ts: Date.now(),
  });
}

function mockOidpFetch(opts: { sub: string; email: string; preferred_username: string }) {
  return jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : String((url as Request).url);

    if (u.includes('.well-known/openid-configuration')) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://mock-oidc.example/auth',
          token_endpoint: 'https://mock-oidc.example/token',
          userinfo_endpoint: 'https://mock-oidc.example/userinfo',
        }),
      } as Response;
    }

    if (u.includes('/token')) {
      expect(init?.method).toBe('POST');
      return {
        ok: true,
        json: async () => ({ access_token: 'mock-at' }),
      } as Response;
    }

    if (u.includes('/userinfo')) {
      return {
        ok: true,
        json: async () => ({
          sub: opts.sub,
          email: opts.email,
          preferred_username: opts.preferred_username,
          name: 'Mock User',
        }),
      } as Response;
    }

    throw new Error(`Unexpected fetch URL in mock: ${u}`);
  });
}

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

describe('GET /api/v1/auth/course/callback', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('redirects first-time course users to oauth-callback with pending token (not immediate token)', async () => {
    const sub = `sub-first-${uniqueSuffix()}`;
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      mockOidpFetch({
        sub,
        email: `first-${uniqueSuffix()}@example.com`,
        preferred_username: `kcuser${uniqueSuffix()}`,
      }),
    );

    const res = await request(app)
      .get('/api/v1/auth/course/callback')
      .query({ code: 'auth-code', state: makeState() })
      .expect(302);

    const loc = res.headers.location || '';
    expect(loc).toContain('/oauth-callback');

    const u = new URL(loc, 'http://dummy.local');
    expect(u.searchParams.get('provider')).toBe('course');
    expect(u.searchParams.has('pending')).toBe(true);
    expect(u.searchParams.has('token')).toBe(false);
    const pending = u.searchParams.get('pending');
    expect(pending).toBeTruthy();
    const payload = verifyOAuthPending(pending);
    expect(payload.provider).toBe('course');
    expect(payload.providerId).toBe(sub);
    expect(payload.email).toBeTruthy();
    expect(payload.preferredUsername).toBeTruthy();
  });

  it('redirects with access token when course IdP subject is already linked', async () => {
    const { user } = await createAuthenticatedUser('courselnk');
    const sub = `sub-linked-${uniqueSuffix()}`;

    await pool.query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_id, email)
       VALUES ($1, 'course', $2, $3)`,
      [user.id, sub, user.email || 'linked@example.com'],
    );

    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      mockOidpFetch({
        sub,
        email: user.email || 'linked@example.com',
        preferred_username: user.username,
      }),
    );

    const res = await request(app)
      .get('/api/v1/auth/course/callback')
      .query({ code: 'auth-code', state: makeState() })
      .expect(302);

    const loc = res.headers.location || '';
    expect(loc).toContain('/oauth-callback');
    const u = new URL(loc, 'http://dummy.local');
    expect(u.searchParams.has('token')).toBe(true);
    expect(u.searchParams.has('pending')).toBe(false);
  });
});

describe('POST /api/v1/auth/oauth/link-intent', () => {
  it('returns a course OAuth URL with linkToken for authenticated user', async () => {
    const { accessToken } = await createAuthenticatedUser('linkcourse');

    const res = await request(app)
      .post('/api/v1/auth/oauth/link-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ provider: 'course' })
      .expect(200);

    expect(res.body.provider).toBe('course');
    expect(res.body.authUrl).toMatch(/^\/api\/v1\/auth\/course\?linkToken=/);
  });
});
