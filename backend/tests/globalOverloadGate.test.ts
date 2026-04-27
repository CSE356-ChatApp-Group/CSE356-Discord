import { request, app, wsServer, pool, closeRedisConnections } from './runtime';

const overload = require('../src/utils/overload');

describe('Global overload gate', () => {
  let shedSpy: jest.SpyInstance;

  beforeEach(() => {
    shedSpy = jest.spyOn(overload, 'shouldShedIncomingRequests').mockReturnValue(true);
  });

  afterEach(() => {
    shedSpy.mockRestore();
  });

  afterAll(async () => {
    await wsServer.shutdown();
    await closeRedisConnections();
    await pool.end();
  });

  it('sheds search route with 429 when global gate is active', async () => {
    const res = await request(app).get('/api/v1/search?q=x&communityId=00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(429);
  });

  it('sheds message read route with 429 when global gate is active', async () => {
    const res = await request(app).put('/api/v1/messages/00000000-0000-0000-0000-000000000000/read');
    expect(res.status).toBe(429);
  });
});

