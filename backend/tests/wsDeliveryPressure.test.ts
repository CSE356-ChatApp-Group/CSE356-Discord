const {
  recordWsReliableRealtimeLatencyMs,
  recordWsBootstrapWallMs,
  recordRealtimeMissAttribution,
  shouldDropReadReceiptFanoutForWsPressure,
  shouldFullyDeferReadReceiptForWsPressure,
  getWsDeliveryPressureSnapshot,
  resetWsDeliveryPressureForTests,
} = require('../src/websocket/wsDeliveryPressure');

describe('wsDeliveryPressure', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'READ_RECEIPT_DROP_FANOUT_ON_WS_PRESSURE_ENABLED',
      'READ_RECEIPT_FULL_DEFER_ON_WS_PRESSURE_ENABLED',
      'READ_RECEIPT_WS_PRESSURE_TTL_MS',
      'READ_RECEIPT_WS_PRESSURE_REALTIME_LATENCY_MS',
      'READ_RECEIPT_WS_PRESSURE_BOOTSTRAP_WALL_MS',
      'READ_RECEIPT_WS_PRESSURE_MISS_COUNT',
    ]) {
      prevEnv[key] = process.env[key];
    }
    process.env.READ_RECEIPT_DROP_FANOUT_ON_WS_PRESSURE_ENABLED = 'true';
    process.env.READ_RECEIPT_FULL_DEFER_ON_WS_PRESSURE_ENABLED = 'false';
    process.env.READ_RECEIPT_WS_PRESSURE_TTL_MS = '50';
    process.env.READ_RECEIPT_WS_PRESSURE_REALTIME_LATENCY_MS = '1000';
    process.env.READ_RECEIPT_WS_PRESSURE_BOOTSTRAP_WALL_MS = '2000';
    process.env.READ_RECEIPT_WS_PRESSURE_MISS_COUNT = '3';
    resetWsDeliveryPressureForTests();
  });

  afterEach(() => {
    resetWsDeliveryPressureForTests();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('activates and expires from high realtime latency', async () => {
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);
    recordWsReliableRealtimeLatencyMs(999);
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);

    recordWsReliableRealtimeLatencyMs(1000);
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(true);
    expect(shouldFullyDeferReadReceiptForWsPressure()).toBe(false);
    expect(getWsDeliveryPressureSnapshot().lastReason).toBe('realtime_latency');

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);
  });

  it('activates from slow bootstrap', () => {
    recordWsBootstrapWallMs(1999);
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);

    recordWsBootstrapWallMs(2000);
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(true);
    expect(getWsDeliveryPressureSnapshot().lastReason).toBe('bootstrap_wall');
  });

  it('activates only after enough relevant realtime misses', () => {
    recordRealtimeMissAttribution('unrelated_reason');
    recordRealtimeMissAttribution('topic_message_partial_delivery');
    recordRealtimeMissAttribution('topic_message_partial_delivery');
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);

    recordRealtimeMissAttribution('topic_message_send_blocked');
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(true);
    expect(getWsDeliveryPressureSnapshot().lastReason).toBe('realtime_miss');
  });

  it('stays disabled when the feature flag is false', () => {
    process.env.READ_RECEIPT_DROP_FANOUT_ON_WS_PRESSURE_ENABLED = 'false';
    process.env.READ_RECEIPT_FULL_DEFER_ON_WS_PRESSURE_ENABLED = 'false';
    recordWsReliableRealtimeLatencyMs(300000);
    recordWsBootstrapWallMs(300000);
    recordRealtimeMissAttribution('topic_message_partial_delivery', 10);
    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);
    expect(shouldFullyDeferReadReceiptForWsPressure()).toBe(false);
    expect(getWsDeliveryPressureSnapshot().active).toBe(false);
  });

  it('tracks pressure for full read deferral without enabling fanout degradation', () => {
    process.env.READ_RECEIPT_DROP_FANOUT_ON_WS_PRESSURE_ENABLED = 'false';
    process.env.READ_RECEIPT_FULL_DEFER_ON_WS_PRESSURE_ENABLED = 'true';

    recordWsBootstrapWallMs(2000);

    expect(shouldDropReadReceiptFanoutForWsPressure()).toBe(false);
    expect(shouldFullyDeferReadReceiptForWsPressure()).toBe(true);
    expect(getWsDeliveryPressureSnapshot()).toMatchObject({
      active: true,
      fanoutDegradeActive: false,
      fullReadDeferActive: true,
      lastReason: 'bootstrap_wall',
    });
  });
});
