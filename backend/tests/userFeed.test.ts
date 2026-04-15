jest.mock('../src/websocket/fanout', () => ({
  publish: jest.fn(() => Promise.resolve()),
}));

const fanout = require('../src/websocket/fanout') as { publish: jest.Mock };
const {
  publishUserFeedTargets,
  splitUserTargets,
  userFeedRedisChannelForUserId,
} = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: (targets: string[], payload: Record<string, unknown>) => Promise<void>;
  splitUserTargets: (targets: string[]) => { userIds: string[]; passthroughTargets: string[] };
  userFeedRedisChannelForUserId: (userId: string) => string;
};

describe('userFeed', () => {
  afterEach(() => {
    fanout.publish.mockReset();
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
});
