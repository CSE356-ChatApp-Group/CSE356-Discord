/**
 * Deferred POST /messages fanout: Redis dedupe, retries, metrics.
 */

const redisStore = new Map<string, string>();

jest.mock("../src/db/redis", () => {
  const api = {
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    set: jest.fn(
      async (
        key: string,
        val: string,
        ...args: Array<string | number>
      ): Promise<string | null> => {
        let modeNx = false;
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === "NX") modeNx = true;
        }
        if (modeNx && redisStore.has(key)) return null;
        redisStore.set(key, val);
        return "OK";
      },
    ),
    del: jest.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  };
  return api;
});

const jobTotal = { inc: jest.fn() };
const retriesTotal = { inc: jest.fn() };
const durationHist = { observe: jest.fn() };
const fanoutLatencyHist = { observe: jest.fn() };
const fanoutRetry = { inc: jest.fn() };
const realtimeFail = { inc: jest.fn() };

jest.mock("../src/utils/metrics", () => ({
  messagePostFanoutJobTotal: jobTotal,
  messagePostFanoutJobRetriesTotal: retriesTotal,
  messagePostFanoutJobDurationMs: durationHist,
  fanoutJobLatencyMs: fanoutLatencyHist,
  fanoutRetryTotal: fanoutRetry,
  messagePostRealtimePublishFailTotal: realtimeFail,
}));

jest.mock("../src/utils/logger", () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

describe("messagePostFanoutAsync", () => {
  beforeEach(() => {
    redisStore.clear();
    jobTotal.inc.mockClear();
    retriesTotal.inc.mockClear();
    durationHist.observe.mockClear();
    fanoutLatencyHist.observe.mockClear();
    fanoutRetry.inc.mockClear();
    realtimeFail.inc.mockClear();
    process.env.MESSAGE_FANOUT_JOB_MAX_ATTEMPTS = "4";
    process.env.MESSAGE_FANOUT_JOB_BACKOFF_MS_BASE = "1";
    jest.resetModules();
  });

  it("runs publish once and marks done (success)", async () => {
    const { runPostMessageFanoutJob } = require("../src/messages/messagePostFanoutAsync");
    const publish = jest.fn(async () => {});
    await runPostMessageFanoutJob("channel", "msg-1", publish);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(jobTotal.inc).toHaveBeenCalledWith({ path: "channel", result: "success" });
    expect(fanoutLatencyHist.observe).toHaveBeenCalledWith(
      { path: "channel", result: "success" },
      expect.any(Number),
    );
    const redis = require("../src/db/redis");
    expect(await redis.get("fanout:v1:done:msg-1")).toBe("1");
  });

  it("skips publish when done marker already set (dedup)", async () => {
    redisStore.set("fanout:v1:done:msg-2", "1");
    const { runPostMessageFanoutJob } = require("../src/messages/messagePostFanoutAsync");
    const publish = jest.fn(async () => {});
    await runPostMessageFanoutJob("channel", "msg-2", publish);
    expect(publish).not.toHaveBeenCalled();
    expect(jobTotal.inc).toHaveBeenCalledWith({ path: "channel", result: "dedup_skip" });
  });

  it("retries publish then succeeds", async () => {
    const { runPostMessageFanoutJob } = require("../src/messages/messagePostFanoutAsync");
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(undefined);
    await runPostMessageFanoutJob("conversation", "msg-3", publish);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(retriesTotal.inc).toHaveBeenCalledWith({ path: "conversation" });
    expect(fanoutRetry.inc).toHaveBeenCalledWith({ path: "conversation" });
    expect(jobTotal.inc).toHaveBeenCalledWith({
      path: "conversation",
      result: "success",
    });
  });

  it("dead-letters after max attempts and increments realtime fail metric", async () => {
    process.env.MESSAGE_FANOUT_JOB_MAX_ATTEMPTS = "2";
    jest.resetModules();
    const { runPostMessageFanoutJob } = require("../src/messages/messagePostFanoutAsync");
    const publish = jest.fn(async () => {
      throw new Error("always fail");
    });
    await runPostMessageFanoutJob("channel", "msg-4", publish);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(jobTotal.inc).toHaveBeenCalledWith({ path: "channel", result: "dead_letter" });
    expect(realtimeFail.inc).toHaveBeenCalledWith({ target: "channel" });
  });

  it("second concurrent run dedup_skips while first holds lock (no double publish)", async () => {
    const { runPostMessageFanoutJob } = require("../src/messages/messagePostFanoutAsync");
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const publish = jest.fn(async () => {
      await blocked;
    });
    const p1 = runPostMessageFanoutJob("channel", "msg-lock", publish);
    for (let i = 0; i < 200 && publish.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(publish).toHaveBeenCalledTimes(1);
    await runPostMessageFanoutJob("channel", "msg-lock", jest.fn(async () => {}));
    expect(jobTotal.inc).toHaveBeenCalledWith({ path: "channel", result: "dedup_skip" });
    release!();
    await p1;
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
