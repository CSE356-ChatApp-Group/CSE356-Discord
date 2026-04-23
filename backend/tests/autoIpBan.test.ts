'use strict';

jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));

const redis = require('../src/db/redis') as {
  get: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

describe('autoIpBan', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  let autoIpBan: {
    isIpAutoBanned: (ip: string) => Promise<boolean>;
    recordRateLimitStrike: (ip: string) => void;
  };

  beforeAll(() => {
    process.env.AUTO_IP_BAN_ENABLED = 'true';
    process.env.AUTO_IP_BAN_STRIKES = '3';
    process.env.AUTO_IP_BAN_STRIKE_WINDOW_SEC = '120';
    process.env.AUTO_IP_BAN_TTL_SEC = '60';
    autoIpBan = require('../src/utils/autoIpBan');
  });

  beforeEach(() => {
    redis.get.mockReset();
    redis.incr.mockReset();
    redis.expire.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.get.mockResolvedValue(null);
    redis.incr.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  afterAll(() => {
    process.env.NODE_ENV = prevNodeEnv;
    delete process.env.AUTO_IP_BAN_ENABLED;
    delete process.env.AUTO_IP_BAN_STRIKES;
    delete process.env.AUTO_IP_BAN_STRIKE_WINDOW_SEC;
    delete process.env.AUTO_IP_BAN_TTL_SEC;
  });

  it('does not ban private IPs', async () => {
    expect(await autoIpBan.isIpAutoBanned('10.0.0.1')).toBe(false);
    autoIpBan.recordRateLimitStrike('10.0.0.2');
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('issues ban after enough strikes', async () => {
    let n = 0;
    redis.incr.mockImplementation(async () => {
      n += 1;
      return n;
    });
    for (let i = 0; i < 3; i += 1) {
      autoIpBan.recordRateLimitStrike('203.0.113.9');
      await new Promise<void>((r) => setTimeout(r, 15));
    }
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('203.0.113.9'),
      '1',
      'EX',
      60,
    );
  });

  it('isIpAutoBanned reads ban key', async () => {
    redis.get.mockImplementation(async (key: string) => (String(key).includes('abuse:ban:') ? '1' : null));
    expect(await autoIpBan.isIpAutoBanned('198.51.100.2')).toBe(true);
    expect(redis.get).toHaveBeenCalledWith(expect.stringContaining('198.51.100.2'));
  });
});
