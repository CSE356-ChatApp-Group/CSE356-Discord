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

describe('join with empty community id', () => {
  it('POST /api/v1/communities//join returns 400 Missing community id', async () => {
    const res = await request(app).post('/api/v1/communities//join').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing community id');
    expect(res.body.requestId).toBeDefined();
  });
});
