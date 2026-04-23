/**
 * Ensures /api/v1/api/v1/... (duplicate prefix from misconfigured harness baseUrl) routes
 * the same as /api/v1/... — see app.ts middleware before /api/v1 mounts.
 */
import { request, app } from './runtime';

describe('duplicate /api/v1 path prefix', () => {
  it('GET /api/v1/api/v1/auth/session matches GET /api/v1/auth/session', async () => {
    const a = await request(app).get('/api/v1/auth/session');
    const b = await request(app).get('/api/v1/api/v1/auth/session');
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
  });
});
