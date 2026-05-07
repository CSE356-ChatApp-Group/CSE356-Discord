/**
 * Tests for the WS delivery tracing layer:
 *   - deliveryTrace helper (worker labels, slow trace emission)
 *   - outboundQueue enqueue/send timing hooks
 *   - redisPubsubDelivery pubsub receive lag metric
 */

import { createRequire } from 'module';
const cjsRequire = createRequire(__filename);

// ── deliveryTrace ──────────────────────────────────────────────────────────────

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  isLevelEnabled: jest.fn(() => false),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const logger = require('../src/utils/logger') as { warn: jest.Mock; debug: jest.Mock; isLevelEnabled: jest.Mock };

describe('deliveryTrace', () => {
  // Use jest-intercepted require so the logger mock applies inside deliveryTrace.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getWorkerLabels, emitSlowDeliveryTrace } = require('../src/websocket/deliveryTrace') as {
    getWorkerLabels: () => { vm: string; worker: string };
    emitSlowDeliveryTrace: (fields: Record<string, unknown>) => void;
  };

  beforeEach(() => {
    logger.warn.mockReset();
    process.env.WS_SLOW_DELIVERY_SAMPLE_RATE = '0'; // disable sampling for deterministic tests
    process.env.WS_SLOW_DELIVERY_TOTAL_MS = '1000';
    process.env.WS_SLOW_DELIVERY_ENQUEUE_MS = '500';
    process.env.WS_SLOW_DELIVERY_PUBSUB_MS = '500';
  });

  afterEach(() => {
    delete process.env.WS_SLOW_DELIVERY_SAMPLE_RATE;
    delete process.env.WS_SLOW_DELIVERY_TOTAL_MS;
    delete process.env.WS_SLOW_DELIVERY_ENQUEUE_MS;
    delete process.env.WS_SLOW_DELIVERY_PUBSUB_MS;
  });

  it('returns stable vm/worker labels', () => {
    const a = getWorkerLabels();
    const b = getWorkerLabels();
    expect(a).toBe(b); // same object reference (memoized)
    expect(typeof a.vm).toBe('string');
    expect(typeof a.worker).toBe('string');
  });

  it('emits slow trace when total_delivery_ms exceeds threshold', () => {
    emitSlowDeliveryTrace({ total_delivery_ms: 1500, messageId: 'msg-1' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0][0];
    expect(call.event).toBe('ws.delivery.slow_trace');
    expect(call.messageId).toBe('msg-1');
    expect(call.total_delivery_ms).toBe(1500);
  });

  it('does not emit trace for fast delivery when sampling disabled', () => {
    emitSlowDeliveryTrace({ total_delivery_ms: 50 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emits slow trace when socket_enqueue_delay_ms exceeds threshold', () => {
    emitSlowDeliveryTrace({ socket_enqueue_delay_ms: 600 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('emits slow trace for stale_map_recovery regardless of latency', () => {
    emitSlowDeliveryTrace({ total_delivery_ms: 10, stale_map_recovery: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('emits slow trace for partial_delivery regardless of latency', () => {
    emitSlowDeliveryTrace({ total_delivery_ms: 10, partial_delivery: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not include PII beyond internal IDs', () => {
    emitSlowDeliveryTrace({
      total_delivery_ms: 2000,
      messageId: 'msg-abc',
      channelId: 'chan-xyz',
      recipientUserId: 'user-123',
    });
    expect(logger.warn).toHaveBeenCalled();
    const call = logger.warn.mock.calls[0][0];
    // Internal IDs are present
    expect(call.messageId).toBe('msg-abc');
    expect(call.channelId).toBe('chan-xyz');
    expect(call.recipientUserId).toBe('user-123');
    // No email, username, or display name fields
    expect(call.email).toBeUndefined();
    expect(call.username).toBeUndefined();
    expect(call.displayName).toBeUndefined();
  });

  it('can emit sampled trace for fast delivery only when sampling is explicitly enabled', () => {
    process.env.WS_SLOW_DELIVERY_SAMPLE_RATE = '1';
    emitSlowDeliveryTrace({ total_delivery_ms: 10, messageId: 'sample-fast' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0][0];
    expect(call.event).toBe('ws.delivery.slow_trace');
    expect(call.total_delivery_ms).toBe(10);
    expect(call.messageId).toBe('sample-fast');
  });

  it('emits at most once per call — does not double-log', () => {
    emitSlowDeliveryTrace({ total_delivery_ms: 2000 });
    emitSlowDeliveryTrace({ total_delivery_ms: 50 }); // fast, no log
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ── outboundQueue: enqueue/send timing ────────────────────────────────────────

jest.mock('../src/websocket/wsDeliveryPressure', () => ({
  recordWsReliableRealtimeLatencyMs: jest.fn(),
  recordRealtimeMissAttribution: jest.fn(),
}));

describe('outboundQueue delivery timing', () => {
  const WebSocket = { OPEN: 1 };

  function makeMetricMock() {
    return { observe: jest.fn(), inc: jest.fn() };
  }

  function makeWs(overrides = {}) {
    return {
      readyState: 1,
      _userId: 'user-1',
      bufferedAmount: 0,
      send: jest.fn((_data: unknown, cb: (err?: Error) => void) => cb()),
      terminate: jest.fn(),
      ...overrides,
    };
  }

  function buildHelpers(extraOpts = {}) {
    const { createOutboundQueueHelpers } = cjsRequire('../src/websocket/outboundQueue');
    return createOutboundQueueHelpers({
      WebSocket,
      logger,
      noteRecentDisconnectForSocket: jest.fn(),
      shouldSkipSocketForLogicalChannel: () => false,
      wasSocketMessageRecentlyDelivered: () => false,
      markSocketMessageDelivered: jest.fn(),
      isReliableRealtimeEvent: () => true,
      wsDeliveryTopicPrefixForMetrics: () => 'channel',
      parsePayloadReferenceTimeMs: () => Date.now() - 200, // 200ms old
      prepareSocketPayload: (_ch: unknown, _p: unknown) => ({
        dedupeKey: 'dk-1',
        outbound: '{}',
        payloadEventName: 'message:created',
        skipDropForBackpressure: true,
      }),
      wsBackpressureEventsTotal: makeMetricMock(),
      wsOutboundQueueDepthHistogram: makeMetricMock(),
      wsOutboundQueuedFramesGauge: { inc: jest.fn(), dec: jest.fn() },
      wsOutboundQueueBlockWaitsTotal: makeMetricMock(),
      wsOutboundQueueDroppedBestEffortTotal: makeMetricMock(),
      wsOutboundDrainBatchesTotal: makeMetricMock(),
      wsReliableDeliveryTotal: makeMetricMock(),
      wsReliableDeliveryLatencyMs: makeMetricMock(),
      wsReliableDeliveryTopicTotal: makeMetricMock(),
      wsRecipientDedupeTotal: makeMetricMock(),
      wsDeliveryStageDurationMs: makeMetricMock(),
      wsDeliverySlowTraceTotal: makeMetricMock(),
      wsSocketQueueDepthHistogram: makeMetricMock(),
      wsSocketSendDurationMs: makeMetricMock(),
      WS_BACKPRESSURE_DROP_BYTES: 16 * 1024 * 1024,
      WS_BACKPRESSURE_KILL_BYTES: 64 * 1024 * 1024,
      WS_OUTBOUND_QUEUE_MAX_MESSAGE: 512,
      WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT: 128,
      WS_OUTBOUND_DRAIN_BATCH: 32,
      WS_OUTBOUND_MESSAGE_WAITERS_MAX: 64,
      ...extraOpts,
    });
  }

  it('accepts pubsubReceiveMs option without altering delivery outcome', async () => {
    const { sendPayloadToSocket } = buildHelpers();
    const ws = makeWs();
    const result = sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {
      pubsubReceiveMs: Date.now() - 100,
    });
    expect(result).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('records wsSocketSendDurationMs on successful send', async () => {
    const wsSocketSendDurationMs = makeMetricMock();
    const { sendPayloadToSocket } = buildHelpers({ wsSocketSendDurationMs });
    const ws = makeWs();
    sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {});
    await new Promise((r) => setImmediate(r));
    expect(wsSocketSendDurationMs.observe).toHaveBeenCalledTimes(1);
    const [labels, value] = wsSocketSendDurationMs.observe.mock.calls[0];
    expect(typeof labels.vm).toBe('string');
    expect(typeof labels.worker).toBe('string');
    expect(typeof value).toBe('number');
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('records wsDeliveryStageDurationMs for socket_write stage', async () => {
    const wsDeliveryStageDurationMs = makeMetricMock();
    const { sendPayloadToSocket } = buildHelpers({ wsDeliveryStageDurationMs });
    const ws = makeWs();
    sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {});
    await new Promise((r) => setImmediate(r));
    const writeCalls = wsDeliveryStageDurationMs.observe.mock.calls.filter(
      ([labels]: [{ stage: string }]) => labels.stage === 'socket_write',
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('records wsSocketQueueDepthHistogram at enqueue time', async () => {
    const wsSocketQueueDepthHistogram = makeMetricMock();
    const { sendPayloadToSocket } = buildHelpers({ wsSocketQueueDepthHistogram });
    const ws = makeWs();
    sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {});
    expect(wsSocketQueueDepthHistogram.observe).toHaveBeenCalledTimes(1);
  });

  it('calls reliable send confirmation hook after ws.send succeeds', async () => {
    const { sendPayloadToSocket } = buildHelpers();
    const ws = makeWs();
    const onReliableSendConfirmed = jest.fn();
    const onReliableSendFailed = jest.fn();
    const result = sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {
      onReliableSendConfirmed,
      onReliableSendFailed,
    });
    expect(result).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(onReliableSendConfirmed).toHaveBeenCalledTimes(1);
    expect(onReliableSendFailed).not.toHaveBeenCalled();
  });

  it('calls reliable send failure hook after ws.send fails', async () => {
    const { sendPayloadToSocket } = buildHelpers();
    const ws = makeWs({
      send: jest.fn((_data: unknown, cb: (err?: Error) => void) => cb(new Error('boom'))),
    });
    const onReliableSendConfirmed = jest.fn();
    const onReliableSendFailed = jest.fn();
    const result = sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {
      onReliableSendConfirmed,
      onReliableSendFailed,
    });
    expect(result).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(onReliableSendConfirmed).not.toHaveBeenCalled();
    expect(onReliableSendFailed).toHaveBeenCalledWith('send_failed');
  });

  it('does not alter delivery when new metric objects are null (graceful degradation)', async () => {
    const { sendPayloadToSocket } = buildHelpers({
      wsDeliveryStageDurationMs: null,
      wsDeliverySlowTraceTotal: null,
      wsSocketQueueDepthHistogram: null,
      wsSocketSendDurationMs: null,
    });
    const ws = makeWs();
    const result = sendPayloadToSocket(ws, 'channel:c1', { event: 'message:created', data: { id: 'm1' } }, null, {});
    expect(result).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});

// ── redisPubsubDelivery: pubsub receive lag ────────────────────────────────────

jest.mock('../src/utils/metrics', () => ({
  fanoutRecipientsHistogram: { observe: jest.fn() },
  realtimeMissAttributionTotal: { inc: jest.fn() },
  wsActiveSubscriberTargetsBucket: { observe: jest.fn() },
  wsFanoutRecoveryInlineTotal: { inc: jest.fn() },
  wsSocketSendTargetsBucket: { observe: jest.fn() },
  wsPubsubReceiveLagMs: { observe: jest.fn() },
}));

jest.mock('../src/websocket/outboundPayload', () => ({
  prepareSocketPayload: jest.fn((_ch: unknown, _p: unknown) => ({
    dedupeKey: 'dk-1',
    outbound: '{}',
    payloadEventName: 'message:created',
    skipDropForBackpressure: true,
  })),
  extractInternalUserFeedCommand: jest.fn(() => null),
  parsePayloadReferenceTimeMs: jest.fn(() => Date.now() - 150),
}));

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn(() => Promise.resolve()),
  isUserFeedEnvelope: jest.fn(() => false),
  isUserFeedWorkerChannel: jest.fn((ch: string) => typeof ch === 'string' && ch.startsWith('userfeed_worker:')),
  userFeedRouteLabelForChannel: jest.fn((ch: string) => (
    typeof ch === 'string' && ch.startsWith('userfeed_worker:')
      ? ch.slice('userfeed_worker:'.length)
      : '0'
  )),
  userIdFromTarget: jest.fn((ch: string) => ch.startsWith('user:') ? ch.slice(5) : null),
}));

jest.mock('../src/websocket/communityFeed', () => ({
  isCommunityFeedEnvelope: jest.fn(() => false),
}));

jest.mock('../src/websocket/redisPubsubTopicUtils', () => ({
  normalizeCommunityTopic: jest.fn((id: unknown) => id),
  isDuplicateSuppressionOnly: jest.fn(() => false),
}));

const { wsPubsubReceiveLagMs } = cjsRequire('../src/utils/metrics') as { wsPubsubReceiveLagMs: { observe: jest.Mock } };
const { createRedisPubsubDelivery } = cjsRequire('../src/websocket/redisPubsubDelivery') as {
  createRedisPubsubDelivery: (ctx: Record<string, unknown>) => { deliverPubsubMessage: (ch: string, msg: string) => Promise<void> };
};

describe('redisPubsubDelivery pubsub receive lag', () => {
  function buildCtx(sendPayloadToSocket = jest.fn(() => true)) {
    return {
      WebSocket: { OPEN: 1 },
      channelClients: new Map([
        ['channel:c1', new Set([{ readyState: 1, _userId: 'u1' }])],
      ]),
      localUserClients: new Map(),
      communityClients: new Map(),
      USER_FEED_SHARD_CHANNEL_SET: new Set<string>(),
      COMMUNITY_FEED_SHARD_CHANNEL_SET: new Set<string>(),
      subscribeClient: jest.fn(),
      unsubscribeClient: jest.fn(() => Promise.resolve()),
      subscribeCommunityClient: jest.fn(),
      unsubscribeCommunityClient: jest.fn(),
      parseChannelKey: jest.fn(() => null),
      sendPayloadToSocket,
    };
  }

  beforeEach(() => {
    wsPubsubReceiveLagMs.observe.mockReset();
    (logger.warn as jest.Mock).mockReset();
    (logger.isLevelEnabled as jest.Mock).mockReturnValue(false);
  });

  it('observes wsPubsubReceiveLagMs with vm/worker labels for channel message', async () => {
    const { deliverPubsubMessage } = createRedisPubsubDelivery(buildCtx());
    const payload = JSON.stringify({
      event: 'message:created',
      data: { id: 'msg-1', created_at: new Date(Date.now() - 100).toISOString() },
    });
    await deliverPubsubMessage('channel:c1', payload);
    expect(wsPubsubReceiveLagMs.observe).toHaveBeenCalledTimes(1);
    const [labels] = wsPubsubReceiveLagMs.observe.mock.calls[0];
    expect(labels.topic_prefix).toBe('channel');
    expect(typeof labels.vm).toBe('string');
    expect(labels.vm.length).toBeGreaterThan(0);
    expect(typeof labels.worker).toBe('string');
  });

  it('passes pubsubReceiveMs through to sendPayloadToSocket', async () => {
    const sendPayloadToSocket = jest.fn(() => true);
    const { deliverPubsubMessage } = createRedisPubsubDelivery(buildCtx(sendPayloadToSocket));
    const payload = JSON.stringify({
      event: 'message:created',
      data: { id: 'msg-2', created_at: new Date(Date.now() - 50).toISOString() },
    });
    await deliverPubsubMessage('channel:c1', payload);
    expect(sendPayloadToSocket).toHaveBeenCalled();
    const opts = (sendPayloadToSocket.mock.calls[0] as unknown[])[4] as Record<string, unknown>;
    expect(typeof opts.pubsubReceiveMs).toBe('number');
    expect(opts.pubsubReceiveMs as number).toBeGreaterThan(0);
  });

  it('does not observe pubsub lag with negative lag (future reference time)', async () => {
    const { parsePayloadReferenceTimeMs } = cjsRequire('../src/websocket/outboundPayload') as { parsePayloadReferenceTimeMs: jest.Mock };
    // Simulate a reference time far in the future → lag would be negative → should not be observed
    parsePayloadReferenceTimeMs.mockReturnValueOnce(Date.now() + 9_999_999);
    wsPubsubReceiveLagMs.observe.mockReset();
    const { deliverPubsubMessage } = createRedisPubsubDelivery(buildCtx());
    await deliverPubsubMessage('channel:c1', JSON.stringify({ event: 'message:created', data: { id: 'x' } }));
    expect(wsPubsubReceiveLagMs.observe).not.toHaveBeenCalled();
  });

  it('does not alter delivery behavior for fast normal deliveries', async () => {
    const sendPayloadToSocket = jest.fn(() => true);
    const { deliverPubsubMessage } = createRedisPubsubDelivery(buildCtx(sendPayloadToSocket));
    const payload = JSON.stringify({
      event: 'message:created',
      data: { id: 'msg-3', created_at: new Date().toISOString() },
    });
    await deliverPubsubMessage('channel:c1', payload);
    expect(sendPayloadToSocket).toHaveBeenCalledTimes(1);
  });
});
