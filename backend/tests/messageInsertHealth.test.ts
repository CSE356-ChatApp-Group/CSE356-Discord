/**
 * Process-local message-insert unhealthy window for read-receipt shedding.
 */

const {
  markMessageInsertUnhealthyForReadShedding,
  getShouldDeferReadReceiptForMessageInsertUnhealthy,
  resetMessageInsertHealthForTests,
} = require("../src/messages/messageInsertHealth");
const {
  shouldMarkReadShedFromPostInsertDbTimeout,
  isMessagePostInsertDbTimeout,
  getMessagePostTimeoutPhase,
} = require("../src/messages/lib/postDiagnostics");

describe("messageInsertHealth", () => {
  afterEach(() => {
    resetMessageInsertHealthForTests();
    delete process.env.READ_RECEIPT_SHED_ON_MESSAGE_INSERT_TIMEOUT_ENABLED;
    delete process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS;
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
  });

  it("expires after TTL", () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS = "3000";
    markMessageInsertUnhealthyForReadShedding();
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(2999);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(2);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
  });

  it("extends deadline when marked again before expiry", () => {
    jest.useFakeTimers({ now: 2_000_000_000_000 });
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS = "5000";
    markMessageInsertUnhealthyForReadShedding();
    jest.advanceTimersByTime(4000);
    markMessageInsertUnhealthyForReadShedding();
    jest.advanceTimersByTime(4000);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(true);
    jest.advanceTimersByTime(2000);
    expect(getShouldDeferReadReceiptForMessageInsertUnhealthy()).toBe(false);
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
    expect(getMessagePostTimeoutPhase({ t_access: 0, t_insert: 0, t_later: 0 })).toBe(
      "access-check",
    );
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
    expect(getMessagePostTimeoutPhase({ t_access: 10, t_insert: 20, t_later: 0 })).toBe(
      "later-step",
    );
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
