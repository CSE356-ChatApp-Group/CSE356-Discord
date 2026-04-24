/**
 * Focused auth rate-limit tests with isolated module loading so limiter env vars
 * can be overridden without affecting the shared integration app bootstrap.
 */

import { createRequire } from 'module';

const cjsRequire = createRequire(__filename);
const request: any = cjsRequire('supertest');

function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

async function clearAuthLimiterKeys(redis: any) {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 200);
    if (Array.isArray(keys) && keys.length > 0) {
      await redis.del(...keys);
    }
    cursor = String(nextCursor);
  } while (cursor !== '0');
}

function makeRegisterPayload(prefix: string) {
  const suffix = uniqueSuffix();
  return {
    email: `${prefix}-${suffix}@example.com`,
    username: `${prefix}${suffix}`.slice(0, 32),
    password: 'Password1!',
  };
}

function buildIsolatedAuthApp(envOverrides: Record<string, string> = {}) {
  jest.resetModules();

  process.env.NODE_ENV = 'production';
  process.env.AUTH_REGISTER_GLOBAL_PER_IP_MAX = envOverrides.AUTH_REGISTER_GLOBAL_PER_IP_MAX || '1';
  process.env.AUTH_REGISTER_GLOBAL_PER_IP_WINDOW_MS =
    envOverrides.AUTH_REGISTER_GLOBAL_PER_IP_WINDOW_MS || String(10 * 60 * 1000);
  delete process.env.DISABLE_RATE_LIMITS;
  delete process.env.TRUST_NGINX_CLIENT_IP_HEADERS;

  const express = cjsRequire('express');
  const authRouter = cjsRequire('../src/auth/router');
  const redis = cjsRequire('../src/db/redis');
  const closeRedisConnections = cjsRequire('../src/db/redis').closeRedisConnections;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);

  return { app, redis, closeRedisConnections };
}

describe('auth rate limit trusted internal bypass', () => {
  const closers: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (!close) continue;
      await close().catch(() => {});
    }
  });

  it('does not rate-limit internal 10.x register traffic', async () => {
    const { app, redis, closeRedisConnections } = buildIsolatedAuthApp();
    closers.push(closeRedisConnections);
    await clearAuthLimiterKeys(redis);

    const first = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '10.0.2.145')
      .send(makeRegisterPayload('internal-bypass-a'));
    const second = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '10.0.2.145')
      .send(makeRegisterPayload('internal-bypass-b'));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('still rate-limits public register traffic', async () => {
    const { app, redis, closeRedisConnections } = buildIsolatedAuthApp();
    closers.push(closeRedisConnections);
    await clearAuthLimiterKeys(redis);

    const first = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '198.51.100.10')
      .send(makeRegisterPayload('public-limit-a'));
    const second = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '198.51.100.10')
      .send(makeRegisterPayload('public-limit-b'));

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({
      error: 'Too many auth attempts from this network. Please wait and try again.',
    });
  });

  it('does not trust forged X-Forwarded-For private IPs when X-Real-IP is public', async () => {
    const { app, redis, closeRedisConnections } = buildIsolatedAuthApp();
    closers.push(closeRedisConnections);
    await clearAuthLimiterKeys(redis);

    const first = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '198.51.100.11')
      .set('X-Forwarded-For', '10.0.0.7')
      .send(makeRegisterPayload('forged-xff-a'));
    const second = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '198.51.100.11')
      .set('X-Forwarded-For', '10.0.0.7')
      .send(makeRegisterPayload('forged-xff-b'));

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });

  it('bypasses the limiter when X-Real-IP is internal even if X-Forwarded-For is public', async () => {
    const { app, redis, closeRedisConnections } = buildIsolatedAuthApp();
    closers.push(closeRedisConnections);
    await clearAuthLimiterKeys(redis);

    const first = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '10.0.0.35')
      .set('X-Forwarded-For', '198.51.100.12')
      .send(makeRegisterPayload('realip-internal-a'));
    const second = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Real-IP', '10.0.0.35')
      .set('X-Forwarded-For', '198.51.100.12')
      .send(makeRegisterPayload('realip-internal-b'));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});
