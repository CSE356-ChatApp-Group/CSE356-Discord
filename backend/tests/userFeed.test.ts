jest.mock('../src/websocket/fanout', () => ({
  publish: jest.fn(() => Promise.resolve()),
}));

const fanout = require('../src/websocket/fanout') as { publish: jest.Mock };
const {
  publishUserFeedTargets,
  runWithConcurrencyLimit,
  splitUserTargets,
  userFeedPublishConcurrency,
  userFeedRedisChannelForUserId,
} = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: (targets: string[], payload: Record<string, unknown>) => Promise<void>;
  runWithConcurrencyLimit: (jobs: Array<() => Promise<void>>, limit: number) => Promise<void>;
  splitUserTargets: (targets: string[]) => { userIds: string[]; passthroughTargets: string[] };
  userFeedPublishConcurrency: () => number;
  userFeedRedisChannelForUserId: (userId: string) => string;
};

function pickUserIdsForDistinctShardChannels(minCount: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; out.length < minCount && i < 500_000; i += 1) {
    const id = `uid${i}`;
    const ch = userFeedRedisChannelForUserId(id);
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(id);
  }
  if (out.length < minCount) {
    throw new Error(`need ${minCount} distinct userfeed shards, got ${out.length}`);
  }
  return out;
}

describe('userFeed', () => {
  const savedConc = process.env.USER_FEED_PUBLISH_CONCURRENCY;

  afterEach(() => {
    fanout.publish.mockReset();
    if (savedConc === undefined) delete process.env.USER_FEED_PUBLISH_CONCURRENCY;
    else process.env.USER_FEED_PUBLISH_CONCURRENCY = savedConc;
  });

  it('splitUserTargets separates user ids from passthrough targets', () => {
    expect(
      splitUserTargets([
        'user:a',
        'conversation:1',
        'user:b',
        'community:1',
        'user:a',
      ]),
    ).toEqual({
      userIds: ['a', 'b'],
      passthroughTargets: ['conversation:1', 'community:1'],
    });
  });

  it('publishUserFeedTargets groups recipients by shard feed', async () => {
    const users = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const expectedGroups = new Map<string, string[]>();
    for (const userId of users) {
      const channel = userFeedRedisChannelForUserId(userId);
      if (!expectedGroups.has(channel)) expectedGroups.set(channel, []);
      expectedGroups.get(channel)!.push(userId);
    }

    await publishUserFeedTargets(users.map((userId) => `user:${userId}`), {
      event: 'message:created',
      data: { id: 'm1' },
    });

    expect(fanout.publish).toHaveBeenCalledTimes(expectedGroups.size);
    const actualGroups = new Map<string, string[]>();
    for (const [channel, envelope] of fanout.publish.mock.calls) {
      actualGroups.set(channel, envelope.__wsRoute.userIds);
      expect(envelope.payload.event).toBe('message:created');
      expect(envelope.payload.data.id).toBe('m1');
    }
    expect(actualGroups).toEqual(expectedGroups);
  });

  it('userFeedPublishConcurrency defaults to 3 and clamps 1..4', () => {
    delete process.env.USER_FEED_PUBLISH_CONCURRENCY;
    expect(userFeedPublishConcurrency()).toBe(3);
    process.env.USER_FEED_PUBLISH_CONCURRENCY = '1';
    expect(userFeedPublishConcurrency()).toBe(1);
    process.env.USER_FEED_PUBLISH_CONCURRENCY = '4';
    expect(userFeedPublishConcurrency()).toBe(4);
    process.env.USER_FEED_PUBLISH_CONCURRENCY = '0';
    expect(userFeedPublishConcurrency()).toBe(1);
    process.env.USER_FEED_PUBLISH_CONCURRENCY = '99';
    expect(userFeedPublishConcurrency()).toBe(4);
    process.env.USER_FEED_PUBLISH_CONCURRENCY = 'not-a-number';
    expect(userFeedPublishConcurrency()).toBe(3);
  });

  it('runWithConcurrencyLimit never exceeds the limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jobs = Array.from({ length: 12 }, () => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    await runWithConcurrencyLimit(jobs, 2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('publishUserFeedTargets publishes each shard once and respects concurrency cap', async () => {
    process.env.USER_FEED_PUBLISH_CONCURRENCY = '2';
    const userIds = pickUserIdsForDistinctShardChannels(10);
    let inFlight = 0;
    let maxInFlight = 0;
    fanout.publish.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
    });

    await publishUserFeedTargets(
      userIds.map((u) => `user:${u}`),
      { event: 'message:created', data: { id: 'm2' } },
    );

    expect(fanout.publish).toHaveBeenCalledTimes(10);
    const channels = fanout.publish.mock.calls.map((c) => c[0] as string);
    expect(new Set(channels).size).toBe(10);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('publishUserFeedTargets propagates fanout.publish errors', async () => {
    fanout.publish.mockRejectedValueOnce(new Error('redis unavailable'));
    const userIds = pickUserIdsForDistinctShardChannels(3);
    await expect(
      publishUserFeedTargets(userIds.map((u) => `user:${u}`), {
        event: 'message:created',
        data: { id: 'm3' },
      }),
    ).rejects.toThrow('redis unavailable');
  });
});
