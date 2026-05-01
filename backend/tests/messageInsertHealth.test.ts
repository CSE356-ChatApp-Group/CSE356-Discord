/**
 * Process-local + Redis fleet visibility for message-insert unhealthy read-receipt shedding.
 */

jest.mock("../src/db/redis", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(0),
}));

const redis = require("../src/db/redis");
const {
  MESSAGE_INSERT_UNHEALTHY_REDIS_KEY,
  markMessageInsertUnhealthyForReadShedding,
  getShouldDeferReadReceiptForMessageInsertUnhealthy,
  resetMessageInsertHealthForTests,
} = require("../src/messages/messageInsertHealth");
const {
  shouldMarkReadShedFromPostInsertDbTimeout,
  isMessagePostInsertDbTimeout,
  getMessagePostTimeoutPhase,
} = require("../src/messages/lib/postDiagnostics");
const {
  messageInsertUnhealthyRedisMarkTotal,
  readReceiptInsertUnhealthyPollTotal,
} = require("../src/utils/metrics");

function counterValueByLabels(counter: any, labels: Record<string, string>) {
  const rows = counter?.hashMap ? Object.values(counter.hashMap as Record<string, any>) : [];
  for (const row of rows as any[]) {
    const rowLabels = row?.labels || {};
    const matches = Object.entries(labels).every(([k, v]) => String(rowLabels[k]) === String(v));
    if (matches) return Number(row?.value || 0);
  }
  return 0;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("messageInsertHealth", () => {
  afterEach(() => {
    resetMessageInsertHealthForTests();
    delete process.env.READ_RECEIPT_SHED_ON_MESSAGE_INSERT_TIMEOUT_ENABLED;
    delete process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS;
    delete process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS;
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue("OK");
    jest.useRealTimers();
  });

  it("defaults to shed enabled with 10s TTL", () => {
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
    markMessageInsertUnhealthyForReadShedding();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
  });

  it("honours READ_RECEIPT_SHED_ON_MESSAGE_INSERT_TIMEOUT_ENABLED=false", () => {
    process.env.READ_RECEIPT_SHED_ON_MESSAGE_INSERT_TIMEOUT_ENABLED = "false";
    markMessageInsertUnhealthyForReadShedding();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("expires after TTL", async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS = "3000";
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "500";
    redis.get.mockResolvedValue(null);
    markMessageInsertUnhealthyForReadShedding();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(2999);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(2);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
  });

  it("extends deadline when marked again before expiry", async () => {
    jest.useFakeTimers({ now: 2_000_000_000_000 });
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS = "5000";
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "500";
    redis.get.mockResolvedValue(null);
    markMessageInsertUnhealthyForReadShedding();
    jest.advanceTimersByTime(4000);
    markMessageInsertUnhealthyForReadShedding();
    jest.advanceTimersByTime(4000);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(2000);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
  });

  it("writes Redis SET with health key and PX TTL on qualifying mark", async () => {
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS = "8000";
    const okBefore = counterValueByLabels(messageInsertUnhealthyRedisMarkTotal, { result: "ok" });
    markMessageInsertUnhealthyForReadShedding();
    expect(redis.set).toHaveBeenCalledWith(
      MESSAGE_INSERT_UNHEALTHY_REDIS_KEY,
      "1",
      "PX",
      8000,
    );
    await flushMicrotasks();
    expect(counterValueByLabels(messageInsertUnhealthyRedisMarkTotal, { result: "ok" })).toBe(okBefore + 1);
  });

  it("sets global cache true immediately on mark without waiting for poll", async () => {
    redis.get.mockResolvedValue(null);
    markMessageInsertUnhealthyForReadShedding();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
  });

  it("defers from global Redis after poll sees key (simulated other worker)", async () => {
    jest.useFakeTimers({ now: 3_000_000_000_000 });
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "500";
    const hitBefore = counterValueByLabels(readReceiptInsertUnhealthyPollTotal, { result: "hit" });
    redis.get.mockResolvedValue("1");
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
    getShouldDeferReadReceiptForMessageInsertUnhealthy();
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    expect(counterValueByLabels(readReceiptInsertUnhealthyPollTotal, { result: "hit" })).toBe(hitBefore + 1);
    jest.useRealTimers();
  });

  it("does not issue Redis GET on repeated preflight checks within the same poll window", async () => {
    jest.useFakeTimers({ now: 4_000_000_000_000 });
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "500";
    redis.get.mockResolvedValue("1");
    getShouldDeferReadReceiptForMessageInsertUnhealthy();
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    const nAfterPoll = redis.get.mock.calls.length;
    for (let i = 0; i < 40; i += 1) {
      getShouldDeferReadReceiptForMessageInsertUnhealthy();
    }
    expect(redis.get.mock.calls.length).toBe(nAfterPoll);
    jest.useRealTimers();
  });

  it("increments redis mark error metric when SET fails without affecting local defer", async () => {
    redis.set.mockRejectedValueOnce(new Error("redis down"));
    const okBefore = counterValueByLabels(messageInsertUnhealthyRedisMarkTotal, { result: "ok" });
    const errBefore = counterValueByLabels(messageInsertUnhealthyRedisMarkTotal, { result: "error" });
    markMessageInsertUnhealthyForReadShedding();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    await flushMicrotasks();
    expect(counterValueByLabels(messageInsertUnhealthyRedisMarkTotal, { result: "error" })).toBe(errBefore + 1);
    expect(counterValueByLabels(messageInsertUnhealthyRedisMarkTotal, { result: "ok" })).toBe(okBefore);
  });

  it("treats Redis GET failure as healthy (fail open)", async () => {
    jest.useFakeTimers({ now: 5_000_000_000_000 });
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "500";
    const errBefore = counterValueByLabels(readReceiptInsertUnhealthyPollTotal, { result: "error" });
    redis.get.mockRejectedValueOnce(new Error("timeout"));
    getShouldDeferReadReceiptForMessageInsertUnhealthy();
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
    expect(counterValueByLabels(readReceiptInsertUnhealthyPollTotal, { result: "error" })).toBe(errBefore + 1);
    jest.useRealTimers();
  });

  it("clears global defer after poll sees miss", async () => {
    jest.useFakeTimers({ now: 1_000_000_000_000 });
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "500";

    redis.get.mockResolvedValueOnce("1").mockResolvedValue(null);
    getShouldDeferReadReceiptForMessageInsertUnhealthy();
    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);

    jest.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
  });

  it("resetMessageInsertHealthForTests clears interval so polls stop", async () => {
    jest.useFakeTimers({ now: 2_000_000_000_000 });
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS = "400";
    redis.get.mockResolvedValue(null);

    getShouldDeferReadReceiptForMessageInsertUnhealthy();
    await flushMicrotasks();
    const nPolls = redis.get.mock.calls.length;

    jest.advanceTimersByTime(400);
    await flushMicrotasks();
    expect(redis.get.mock.calls.length).toBeGreaterThan(nPolls);

    resetMessageInsertHealthForTests();
    redis.get.mockResolvedValue(null);
    const frozen = redis.get.mock.calls.length;

    jest.advanceTimersByTime(50_000);
    await flushMicrotasks();
    expect(redis.get.mock.calls.length).toBe(frozen);
  });
});

describe("shouldMarkReadShedFromPostInsertDbTimeout", () => {
  /**
   * Production (2026-05-01): timeoutPhase "insert", pgCode 57014, tx_access_check_ms ~1,
   * tx_insert_ms ~5500–6700 in logs. Those durations are derived in the logger from wall clock;
   * `txPhases.t_insert` stays 0 until the INSERT query returns, so marking uses phase "insert".
   */
  it("matches incident shape: 57014 + access done + INSERT not returned (t_insert still 0)", () => {
    const err = {
      code: "57014",
      message: "canceling statement due to statement timeout",
    };
    const t0 = 1_707_000_000_000;
    const txPhases = {
      t0,
      t_access: t0 + 1,
      t_insert: 0,
      t_later: 0,
    };
    expect(getMessagePostTimeoutPhase(txPhases)).toBe("insert");
    expect(isMessagePostInsertDbTimeout(err)).toBe(true);
    expect(shouldMarkReadShedFromPostInsertDbTimeout(err, txPhases)).toBe(true);
  });

  it("is true for 57014 when insert phase incomplete", () => {
    const err = { code: "57014", message: "canceling statement due to statement timeout" };
    expect(isMessagePostInsertDbTimeout(err)).toBe(true);
    expect(
      shouldMarkReadShedFromPostInsertDbTimeout(err, {
        t_access: 10,
        t_insert: 0,
        t_later: 0,
      }),
    ).toBe(true);
  });

  it("is false when access phase has not started", () => {
    const err = { code: "57014", message: "timeout" };
    expect(getMessagePostTimeoutPhase({ t_access: 0, t_insert: 0, t_later: 0 })).toBe("access-check");
    expect(
      shouldMarkReadShedFromPostInsertDbTimeout(err, {
        t_access: 0,
        t_insert: 0,
        t_later: 0,
      }),
    ).toBe(false);
  });

  it("is false when insert phase already recorded (later-step / diagnostic — not insert phase)", () => {
    const err = { code: "57014", message: "timeout" };
    expect(getMessagePostTimeoutPhase({ t_access: 10, t_insert: 20, t_later: 0 })).toBe("later-step");
    expect(
      shouldMarkReadShedFromPostInsertDbTimeout(err, {
        t_access: 10,
        t_insert: 20,
        t_later: 0,
      }),
    ).toBe(false);
  });

  it("is false for non-timeout errors even if phase would be insert", () => {
    const err = { code: "23505", message: "unique violation" };
    expect(
      shouldMarkReadShedFromPostInsertDbTimeout(err, {
        t_access: 10,
        t_insert: 0,
        t_later: 0,
      }),
    ).toBe(false);
  });
});
