/**
 * Per-user Redis fanout for channel message:created (default on; opt out with CHANNEL_MESSAGE_USER_FANOUT=0).
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
  publishChannelMessageCreated: (channelId: string, env: Record<string, unknown>) => Promise<void>;
  getChannelUserFanoutTargetKeys: (channelId: string) => Promise<string[]>;
};

describe('channelRealtimeFanout', () => {
  const prevFanout = process.env.CHANNEL_MESSAGE_USER_FANOUT;

  afterEach(() => {
    process.env.CHANNEL_MESSAGE_USER_FANOUT = prevFanout;
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

  it('publishChannelMessageCreated publishes only channel when fanout disabled', async () => {
    process.env.CHANNEL_MESSAGE_USER_FANOUT = '0';
    await publishChannelMessageCreated('c1', { event: 'message:created', data: {} });
    expect(fanout.publish).toHaveBeenCalledTimes(1);
    expect(fanout.publish).toHaveBeenCalledWith('channel:c1', expect.any(Object));
  });

  it('publishChannelMessageCreated publishes channel plus user targets when fanout is default on', async () => {
    delete process.env.CHANNEL_MESSAGE_USER_FANOUT;
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    expect(fanout.publish).toHaveBeenCalledTimes(3);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
      'channel:c1',
      'user:a',
      'user:b',
    ]);
  });
});
