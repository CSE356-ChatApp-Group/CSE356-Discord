import { request, app } from './runtime';

const overload = require('../src/utils/overload');

describe('Global overload gate', () => {
  let shedSpy: jest.SpyInstance;

  beforeEach(() => {
    shedSpy = jest.spyOn(overload, 'shouldShedIncomingRequests').mockReturnValue(true);
  });

  afterEach(() => {
    shedSpy.mockRestore();
  });

  // Do not call closeRedisConnections / pool.end / wsServer.shutdown here: Jest runs
  // many files in one process (--runInBand). Tearing down shared singletons would
  // break every subsequent integration test with "Connection is closed" / EPIPE.

  it('sheds search route with 429 when global gate is active', async () => {
    const res = await request(app).get('/api/v1/search?q=x&communityId=00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(429);
  });

  it('sheds message read route with 429 when global gate is active', async () => {
    const res = await request(app).put('/api/v1/messages/00000000-0000-0000-0000-000000000000/read');
    expect(res.status).toBe(429);
  });
});

