jest.mock('../src/db/redis', () => ({
  multi: jest.fn(),
}));

const redis = require('../src/db/redis') as { multi: jest.Mock };
const { markChannelsRecentConnect } = require('../src/websocket/recentConnect') as {
  markChannelsRecentConnect: (userId: string, channelIds: string[]) => Promise<void>;
};

describe('recentConnect bulk channel markers', () => {
  const previousChannelRecentZsetEnabled = process.env.CHANNEL_RECENT_ZSET_ENABLED;

  afterEach(() => {
    redis.multi.mockReset();
    if (previousChannelRecentZsetEnabled === undefined) delete process.env.CHANNEL_RECENT_ZSET_ENABLED;
    else process.env.CHANNEL_RECENT_ZSET_ENABLED = previousChannelRecentZsetEnabled;
  });

  it('marks every unique joined channel in a single Redis multi', async () => {
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const multi = {
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    redis.multi.mockReturnValue(multi);

    await markChannelsRecentConnect('user-1', ['chan-1', 'chan-2', 'chan-1', '']);

    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(multi.zremrangebyscore).toHaveBeenCalledTimes(2);
    expect(multi.zremrangebyscore).toHaveBeenNthCalledWith(
      1,
      'channel:recent_connect:chan-1',
      '-inf',
      expect.any(Number),
    );
    expect(multi.zremrangebyscore).toHaveBeenNthCalledWith(
      2,
      'channel:recent_connect:chan-2',
      '-inf',
      expect.any(Number),
    );
    expect(multi.zadd).toHaveBeenNthCalledWith(
      1,
      'channel:recent_connect:chan-1',
      expect.any(Number),
      'user-1',
    );
    expect(multi.zadd).toHaveBeenNthCalledWith(
      2,
      'channel:recent_connect:chan-2',
      expect.any(Number),
      'user-1',
    );
    expect(multi.expire).toHaveBeenNthCalledWith(1, 'channel:recent_connect:chan-1', 120);
    expect(multi.expire).toHaveBeenNthCalledWith(2, 'channel:recent_connect:chan-2', 120);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });
});
