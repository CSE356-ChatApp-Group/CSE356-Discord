/**
 * @jest-environment node
 */

const {
  expandFanoutBatchEntriesWithAliases,
  isRealtimeEventAliasFanoutEnabled,
} = require("../src/realtime/realtimeEventAliases");

describe("realtime/realtimeEventAliases", () => {
  const prev = process.env.REALTIME_EVENT_ALIAS_FANOUT;

  afterEach(() => {
    if (prev === undefined) delete process.env.REALTIME_EVENT_ALIAS_FANOUT;
    else process.env.REALTIME_EVENT_ALIAS_FANOUT = prev;
  });

  it("returns entries unchanged when REALTIME_EVENT_ALIAS_FANOUT is off", () => {
    delete process.env.REALTIME_EVENT_ALIAS_FANOUT;
    const entries = [
      { channel: "channel:x", payload: { event: "message:created", data: { id: "m1" } } },
    ];
    expect(expandFanoutBatchEntriesWithAliases(entries)).toBe(entries);
    expect(isRealtimeEventAliasFanoutEnabled()).toBe(false);
  });

  it("expands flat payloads with alias events when enabled", () => {
    process.env.REALTIME_EVENT_ALIAS_FANOUT = "1";
    const entries = [
      { channel: "channel:x", payload: { event: "message:created", data: { id: "m1" } } },
    ];
    const expanded = expandFanoutBatchEntriesWithAliases(entries);
    expect(expanded).toHaveLength(2);
    expect(expanded[0].payload.event).toBe("message:created");
    expect(expanded[1].payload.event).toBe("new_message");
    expect(expanded[1].channel).toBe("channel:x");
  });

  it("expands userfeed envelopes on inner payload.event when enabled", () => {
    process.env.REALTIME_EVENT_ALIAS_FANOUT = "1";
    const inner = { event: "read:updated", data: { userId: "u1", lastReadMessageId: "m9" } };
    const entries = [
      {
        channel: "userfeed:0",
        payload: {
          __wsRoute: { kind: "users", userIds: ["u1"] },
          payload: inner,
        },
      },
    ];
    const expanded = expandFanoutBatchEntriesWithAliases(entries);
    expect(expanded.length).toBeGreaterThanOrEqual(4);
    const events = expanded.map((e: any) => e.payload.payload?.event || e.payload.event);
    expect(events).toContain("read:updated");
    expect(events).toContain("message:read");
    expect(events).toContain("read:receipt");
    expect(events).toContain("read_receipt");
  });
});
