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
  wsDuplicateDeliverySuppressedTotal: {
    inc: jest.fn(),
  },
  wsDedupeEnqueueReservedTotal: {
    inc: jest.fn(),
  },
  wsDedupeSendConfirmedTotal: {
    inc: jest.fn(),
  },
  wsDedupeSendFailedTotal: {
    inc: jest.fn(),
  },
}));

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn(() => Promise.resolve()),
  isUserFeedEnvelope: jest.fn(() => false),
  isUserFeedWorkerChannel: jest.fn((channel: string) => typeof channel === 'string' && channel.startsWith('userfeed_worker:')),
  userFeedRouteLabelForChannel: jest.fn((channel: string) => (
    typeof channel === 'string' && channel.startsWith('userfeed_worker:')
      ? channel.slice('userfeed_worker:'.length)
      : '0'
  )),
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
const {
  wsDuplicateDeliverySuppressedTotal,
  wsDedupeEnqueueReservedTotal,
  wsDedupeSendConfirmedTotal,
  wsDedupeSendFailedTotal,
} = require('../src/utils/metrics') as {
  wsDuplicateDeliverySuppressedTotal: { inc: jest.Mock };
  wsDedupeEnqueueReservedTotal: { inc: jest.Mock };
  wsDedupeSendConfirmedTotal: { inc: jest.Mock };
  wsDedupeSendFailedTotal: { inc: jest.Mock };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publishUserFeedTargets } = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRedisPubsubDelivery } = require('../src/websocket/redisPubsubDelivery') as {
  createRedisPubsubDelivery: (ctx: Record<string, unknown>) => {
    deliverPubsubMessage: (channel: string, message: string) => Promise<void>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createFanoutRecipientDedupe } = require('../src/websocket/fanoutRecipientDedupe') as {
  createFanoutRecipientDedupe: (metrics: Record<string, unknown>) => {
    hasSeenRecipient: (messageId: string, userId: string, eventName?: string, connectionId?: string) => boolean;
    markRecipient: (messageId: string, userId: string, path: string, eventName?: string, connectionId?: string) => void;
    markDuplicateRecipient: (messageId: string, userId: string, path: string, eventName?: string) => void;
    reserveRecipient: (messageId: string, userId: string, path: string, eventName?: string, connectionId?: string) => string | null;
    confirmRecipient: (messageId: string, userId: string, eventName?: string, connectionId?: string, token?: string | null) => boolean;
    releaseRecipient: (messageId: string, userId: string, eventName?: string, connectionId?: string, token?: string | null) => boolean;
  };
};

describe('redisPubsubDelivery', () => {
  beforeEach(() => {
    logger.warn.mockReset();
    logger.debug.mockReset();
    logger.isLevelEnabled.mockReset();
    logger.isLevelEnabled.mockReturnValue(false);
    realtimeMissAttributionTotal.inc.mockReset();
    wsDuplicateDeliverySuppressedTotal.inc.mockReset();
    wsDedupeEnqueueReservedTotal.inc.mockReset();
    wsDedupeSendConfirmedTotal.inc.mockReset();
    wsDedupeSendFailedTotal.inc.mockReset();
    publishUserFeedTargets.mockReset();
    publishUserFeedTargets.mockResolvedValue(undefined);
  });

  function createCtx(sendPayloadToSocket: jest.Mock, overrides: Record<string, unknown> = {}) {
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
      ...overrides,
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
    const partialMetric = { inc: jest.fn() };
    const sendPayloadToSocket = jest.fn((_ws: any, _logicalChannel: any, _parsed: any, _rawMessage: any, opts: any) => {
      opts.debugReasonCounts.not_open = 1;
      return false;
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      wsPartialDeliveryMissingReasonTotal: partialMetric,
    }));
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
    expect(partialMetric.inc).toHaveBeenCalledWith({ reason: 'socket_not_open' }, 1);
  });

  it('increments partial delivery reason metrics for real partial misses', async () => {
    const partialMetric = { inc: jest.fn() };
    const openA = { readyState: 1, _userId: 'user-1' };
    const openB = { readyState: 1, _userId: 'user-2' };
    const sendPayloadToSocket = jest.fn((_ws: any, _logicalChannel: any, _parsed: any, _rawMessage: any, opts: any) => {
      if (_ws === openA) return true;
      opts.debugReasonCounts.logical_suppressed = 1;
      return false;
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', new Set([openA, openB])],
      ]),
      wsPartialDeliveryMissingReasonTotal: partialMetric,
    }));
    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-3' } }),
    );

    expect(realtimeMissAttributionTotal.inc).toHaveBeenCalledWith(
      { reason: 'topic_message_partial_delivery' },
    );
    expect(partialMetric.inc).toHaveBeenCalledWith({ reason: 'not_subscribed' }, 1);
  });

  it('records dedupe-only partial topic slots as duplicate suppression, not missing delivery', async () => {
    const partialMetric = { inc: jest.fn() };
    const duplicateCandidateMetric = { inc: jest.fn() };
    const dedupeMetric = { inc: jest.fn() };
    const fanoutRecipientDedupe = createFanoutRecipientDedupe({
      wsRecipientDedupeTotal: dedupeMetric,
      wsRecipientDuplicateCandidatesTotal: duplicateCandidateMetric,
    });
    fanoutRecipientDedupe.markRecipient(
      'msg-dedupe-only',
      'user-2',
      'user_topic',
      'message:created',
      'conn-2',
    );
    const openA = { readyState: 1, _userId: 'user-1', _connectionId: 'conn-1' };
    const openB = { readyState: 1, _userId: 'user-2', _connectionId: 'conn-2' };
    const sendPayloadToSocket = jest.fn((ws: any) => ws === openA);

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', new Set([openA, openB])],
      ]),
      fanoutRecipientDedupe,
      wsPartialDeliveryMissingReasonTotal: partialMetric,
    }));

    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-dedupe-only' } }),
    );

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);
    expect(realtimeMissAttributionTotal.inc).not.toHaveBeenCalledWith(
      { reason: 'topic_message_partial_delivery' },
    );
    expect(partialMetric.inc).not.toHaveBeenCalledWith({ reason: 'dedupe_skip' }, expect.anything());
    expect(wsDuplicateDeliverySuppressedTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'channel_topic', reason: 'dedupe_skip' }),
      1,
    );
    expect(duplicateCandidateMetric.inc).toHaveBeenCalledWith({ path: 'channel_topic' });
  });

  it('dedupes before enqueue when another path already marked the recipient', async () => {
    const duplicateMetric = { markDuplicateRecipient: jest.fn(), hasSeenRecipient: jest.fn(() => true) };
    const sendPayloadToSocket = jest.fn();

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      fanoutRecipientDedupe: duplicateMetric,
    }));
    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-4' } }),
    );

    expect(sendPayloadToSocket).not.toHaveBeenCalled();
    expect(duplicateMetric.markDuplicateRecipient).toHaveBeenCalledWith(
      'msg-4',
      'user-1',
      'channel_topic',
      'message:created',
    );
  });

  it('does not dedupe distinct lifecycle events for the same message recipient', async () => {
    const sendPayloadToSocket = jest.fn(() => true);
    const fanoutRecipientDedupe = createFanoutRecipientDedupe({
      wsRecipientDedupeTotal: { inc: jest.fn() },
      wsRecipientDuplicateCandidatesTotal: { inc: jest.fn() },
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      fanoutRecipientDedupe,
    }));

    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-5' } }),
    );
    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:updated', data: { id: 'msg-5' } }),
    );
    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:deleted', data: { id: 'msg-5' } }),
    );

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(3);
  });

  it('delivers the same event to every open socket for a recipient before cross-path dedupe', async () => {
    const sendPayloadToSocket = jest.fn(() => true);
    const fanoutRecipientDedupe = createFanoutRecipientDedupe({
      wsRecipientDedupeTotal: { inc: jest.fn() },
      wsRecipientDuplicateCandidatesTotal: { inc: jest.fn() },
    });
    const openA = { readyState: 1, _userId: 'user-1' };
    const openB = { readyState: 1, _userId: 'user-1' };

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', new Set([openA, openB])],
      ]),
      fanoutRecipientDedupe,
    }));

    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-6' } }),
    );

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(2);
  });

  it('releases a queued reservation after send failure so a later recovery path can deliver', async () => {
    const sendCallbacks: Array<(reason?: string) => void> = [];
    const sendPayloadToSocket = jest.fn((_ws: any, _logicalChannel: any, _parsed: any, _rawMessage: any, opts: any) => {
      sendCallbacks.push(opts.onReliableSendFailed);
      return true;
    });
    const fanoutRecipientDedupe = createFanoutRecipientDedupe({
      wsRecipientDedupeTotal: { inc: jest.fn() },
      wsRecipientDuplicateCandidatesTotal: { inc: jest.fn() },
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', new Set([{ readyState: 1, _userId: 'user-1', _connectionId: 'conn-1' }])],
      ]),
      fanoutRecipientDedupe,
      wsPartialDeliveryMissingReasonTotal: { inc: jest.fn() },
    }));
    const payload = JSON.stringify({ event: 'message:created', data: { id: 'msg-send-fail' } });

    await deliverPubsubMessage('channel:chan-1', payload);
    await deliverPubsubMessage('channel:chan-1', payload);
    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);

    sendCallbacks[0]('send_failed');
    await deliverPubsubMessage('channel:chan-1', payload);

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(2);
    expect(wsDedupeSendFailedTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'channel_topic' }),
      1,
    );
  });

  it('keeps a confirmed send suppressed for later duplicate paths', async () => {
    const sendCallbacks: Array<() => void> = [];
    const sendPayloadToSocket = jest.fn((_ws: any, _logicalChannel: any, _parsed: any, _rawMessage: any, opts: any) => {
      sendCallbacks.push(opts.onReliableSendConfirmed);
      return true;
    });
    const fanoutRecipientDedupe = createFanoutRecipientDedupe({
      wsRecipientDedupeTotal: { inc: jest.fn() },
      wsRecipientDuplicateCandidatesTotal: { inc: jest.fn() },
    });

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', new Set([{ readyState: 1, _userId: 'user-1', _connectionId: 'conn-1' }])],
      ]),
      fanoutRecipientDedupe,
    }));
    const payload = JSON.stringify({ event: 'message:created', data: { id: 'msg-send-ok' } });

    await deliverPubsubMessage('channel:chan-1', payload);
    sendCallbacks[0]();
    await deliverPubsubMessage('channel:chan-1', payload);

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);
    expect(wsDedupeSendConfirmedTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'channel_topic' }),
      1,
    );
  });

  it('skips stale subscription entries and still delivers to remaining open sockets', async () => {
    const stale = { readyState: 3, _userId: 'user-stale' };
    const open = { readyState: 1, _userId: 'user-open' };
    const clients = new Set([stale, open]);
    const unsubscribeClient = jest.fn((ws) => {
      clients.delete(ws);
      return Promise.resolve();
    });
    const sendPayloadToSocket = jest.fn(() => true);

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', clients],
      ]),
      unsubscribeClient,
    }));

    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-stale-safe' } }),
    );

    expect(unsubscribeClient).toHaveBeenCalledWith(stale, 'channel:chan-1');
    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);
    expect((sendPayloadToSocket.mock.calls as unknown as any[][])[0][0]).toBe(open);
  });

  it('schedules stale-map recovery even when some recipients still receive the message', async () => {
    const stale = { readyState: 3, _userId: 'user-stale' };
    const open = { readyState: 1, _userId: 'user-open' };
    const clients = new Set([stale, open]);
    const unsubscribeClient = jest.fn((ws) => {
      clients.delete(ws);
      return Promise.resolve();
    });
    const sendPayloadToSocket = jest.fn(() => true);
    const enqueuePendingMessageForUsers = jest.fn(() => Promise.resolve());

    const { deliverPubsubMessage } = createRedisPubsubDelivery(createCtx(sendPayloadToSocket, {
      channelClients: new Map([
        ['channel:chan-1', clients],
      ]),
      unsubscribeClient,
      enqueuePendingMessageForUsers,
    }));

    await deliverPubsubMessage(
      'channel:chan-1',
      JSON.stringify({ event: 'message:created', data: { id: 'msg-stale-recover' } }),
    );

    // Let setImmediate recovery callback run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);
    expect(publishUserFeedTargets).toHaveBeenCalledWith(
      ['user:user-stale'],
      expect.objectContaining({ event: 'message:created' }),
    );
    expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
      ['user-stale'],
      expect.objectContaining({ event: 'message:created' }),
      {},
    );
  });
});
