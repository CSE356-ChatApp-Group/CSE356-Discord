jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  isLevelEnabled: jest.fn(() => false),
}));

jest.mock('../src/utils/metrics', () => ({
  fanoutRecipientsHistogram: {
    observe: jest.fn(),
  },
  realtimeMissAttributionTotal: {
    inc: jest.fn(),
  },
}));

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn(() => Promise.resolve()),
  isUserFeedEnvelope: jest.fn(() => false),
  userIdFromTarget: jest.fn((channel: string) => (
    typeof channel === 'string' && channel.startsWith('user:')
      ? channel.slice('user:'.length)
      : null
  )),
}));

jest.mock('../src/websocket/communityFeed', () => ({
  isCommunityFeedEnvelope: jest.fn(() => false),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const logger = require('../src/utils/logger') as {
  warn: jest.Mock;
  debug: jest.Mock;
  isLevelEnabled: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { realtimeMissAttributionTotal } = require('../src/utils/metrics') as {
  realtimeMissAttributionTotal: { inc: jest.Mock };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRedisPubsubDelivery } = require('../src/websocket/redisPubsubDelivery') as {
  createRedisPubsubDelivery: (ctx: Record<string, unknown>) => {
    deliverPubsubMessage: (channel: string, message: string) => Promise<void>;
  };
};

describe('redisPubsubDelivery', () => {
  beforeEach(() => {
    logger.warn.mockReset();
    logger.debug.mockReset();
    logger.isLevelEnabled.mockReset();
    logger.isLevelEnabled.mockReturnValue(false);
    realtimeMissAttributionTotal.inc.mockReset();
  });

  function createCtx(sendPayloadToSocket: jest.Mock) {
    return {
      WebSocket: { OPEN: 1 },
      channelClients: new Map([
        ['channel:chan-1', new Set([{ readyState: 1, _userId: 'user-1' }])],
      ]),
      localUserClients: new Map(),
      communityClients: new Map(),
      USER_FEED_SHARD_CHANNEL_SET: new Set(),
      COMMUNITY_FEED_SHARD_CHANNEL_SET: new Set(),
      subscribeClient: jest.fn(),
      unsubscribeClient: jest.fn(() => Promise.resolve()),
      subscribeCommunityClient: jest.fn(),
      unsubscribeCommunityClient: jest.fn(),
      parseChannelKey: jest.fn(() => null),
      sendPayloadToSocket,
    };
  }

  it('does not attribute duplicate-only suppression as a realtime delivery block', async () => {
    const sendPayloadToSocket = jest.fn((_ws: any, _logicalChannel: any, _parsed: any, _rawMessage: any, opts: any) => {
      opts.debugReasonCounts.dedupe_recent_delivery = 1;
      return false;
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket));
    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-1' } }),
    );

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(realtimeMissAttributionTotal.inc).not.toHaveBeenCalledWith(
      { reason: 'topic_message_send_blocked' },
    );
  });

  it('still attributes realtime delivery blocks for non-deduped misses', async () => {
    const sendPayloadToSocket = jest.fn((_ws: any, _logicalChannel: any, _parsed: any, _rawMessage: any, opts: any) => {
      opts.debugReasonCounts.not_open = 1;
      return false;
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket));
    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-2' } }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ws.realtime_delivery_blocked',
        channel: 'channel:chan-1',
        reasonCounts: { not_open: 1 },
      }),
      'Reliable realtime message had recipients but zero successful socket sends',
    );
    expect(realtimeMissAttributionTotal.inc).toHaveBeenCalledWith(
      { reason: 'topic_message_send_blocked' },
    );
  });
});
