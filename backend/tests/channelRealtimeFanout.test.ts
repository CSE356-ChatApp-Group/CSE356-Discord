/**
 * Channel message:created fanout targets every visible member's user topic.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/websocket/fanout', () => ({
  publish: jest.fn(() => Promise.resolve()),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fanout = require('../src/websocket/fanout') as { publish: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  publishChannelMessageCreated,
  getChannelUserFanoutTargetKeys,
} = require('../src/messages/channelRealtimeFanout') as {
  publishChannelMessageCreated: (channelId: string, envelope: Record<string, unknown>) => Promise<void>;
  getChannelUserFanoutTargetKeys: (channelId: string) => Promise<string[]>;
};

describe('channelRealtimeFanout', () => {
  afterEach(() => {
    query.mockReset();
    fanout.publish.mockReset();
  });

  it('getChannelUserFanoutTargetKeys returns distinct user: keys from query rows', async () => {
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u1' }],
    });
    const keys = await getChannelUserFanoutTargetKeys('chan-1');
    expect(keys).toEqual(['user:u1', 'user:u2']);
  });

  it('publishChannelMessageCreated publishes to all visible member user targets', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    expect(fanout.publish).toHaveBeenCalledTimes(2);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
      'user:a',
      'user:b',
    ]);
  });
});
