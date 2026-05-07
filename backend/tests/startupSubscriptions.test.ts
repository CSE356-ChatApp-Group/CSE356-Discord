jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { createStartupSubscriptionsLifecycle } = require('../src/websocket/startupSubscriptions');

describe('startup Redis subscriptions', () => {
  it('subscribes the worker-owned userfeed topic plus fixed community shard feeds on startup', async () => {
    const ensureRedisChannelSubscribed = jest.fn().mockResolvedValue(undefined);
    const communityFeedShardChannels = Array.from({ length: 64 }, (_unused, idx) => `communityfeed:${idx}`);
    const workerUserFeedChannel = 'userfeed_worker:vm2:4001';
    const { ready } = createStartupSubscriptionsLifecycle({
      ensureRedisChannelSubscribed,
      communityFeedShardChannels,
      workerUserFeedChannel,
      logWsHotInfo: jest.fn(),
    });

    await ready();

    const expected = new Set([workerUserFeedChannel, ...communityFeedShardChannels]);
    const deadline = Date.now() + 1000;
    while (ensureRedisChannelSubscribed.mock.calls.length < expected.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const subscribedTopics = ensureRedisChannelSubscribed.mock.calls.map((call: string[]) => call[0]);
    expect(subscribedTopics).toHaveLength(expected.size);
    expect(new Set(subscribedTopics)).toEqual(expected);
    expect(subscribedTopics).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(channel|conversation|user):/),
      ]),
    );
    expect(subscribedTopics).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^userfeed:/),
      ]),
    );
  });
});
