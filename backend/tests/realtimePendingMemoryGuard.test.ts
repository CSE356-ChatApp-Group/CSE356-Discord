const pipelineExec = jest.fn();
const pipelineSet = jest.fn();
const pipelineZadd = jest.fn();
const pipelineExpire = jest.fn();
const pipelineZremrangebyrank = jest.fn();
const pipelineZcard = jest.fn();

const redisMock = {
  status: "ready",
  info: jest.fn(),
  pipeline: jest.fn(() => ({
    exists: jest.fn().mockReturnThis(),
    scard: jest.fn().mockReturnThis(),
    set: pipelineSet.mockReturnThis(),
    zadd: pipelineZadd.mockReturnThis(),
    expire: pipelineExpire.mockReturnThis(),
    zremrangebyrank: pipelineZremrangebyrank.mockReturnThis(),
    zcard: pipelineZcard.mockReturnThis(),
    exec: pipelineExec,
  })),
};

jest.mock("../src/db/redis", () => redisMock);
jest.mock("../src/websocket/recentConnect", () => ({
  wsRecentConnectKey: (id: string) => `ws:recent_connect:${id}`,
  wsReplayPendingEligibilityKey: (id: string) => `ws:replay_pending_eligible:${id}`,
  WS_REPLAY_RECENT_USER_WINDOW_SECONDS: 30,
}));
jest.mock("../src/messages/messageHydrate", () => ({
  loadHydratedMessageById: jest.fn(async () => null),
  loadHydratedMessagesByIds: jest.fn(async () => new Map()),
}));
jest.mock("../src/messages/realtimePayload", () => ({
  wrapFanoutPayload: jest.fn((event: string, row: any) => ({ event, data: row })),
}));
const trimMetric = { inc: jest.fn() };
const zsetSizeMetric = { observe: jest.fn() };
const guardMetric = { inc: jest.fn() };
const pendingClassMetric = { inc: jest.fn() };
const pendingEntriesHist = { observe: jest.fn() };
const offlineSkipMetric = { inc: jest.fn() };
jest.mock("../src/utils/metrics", () => ({
  wsPendingReplayUserTrimmedTotal: trimMetric,
  wsPendingUserZsetSize: zsetSizeMetric,
  wsPendingReplayGuardTotal: guardMetric,
  pendingReplayRecipientTotal: pendingClassMetric,
  pendingReplayEntriesPerMessage: pendingEntriesHist,
  offlinePendingSkippedTotal: offlineSkipMetric,
}));
const loggerWarn = jest.fn();
jest.mock("../src/utils/logger", () => ({
  warn: loggerWarn,
  info: jest.fn(),
  error: jest.fn(),
}));

describe("realtimePending enqueue safeguards", () => {
  beforeEach(() => {
    jest.resetModules();
    redisMock.pipeline.mockClear();
    pipelineExec.mockReset();
    pipelineSet.mockReset();
    pipelineZadd.mockReset();
    pipelineExpire.mockReset();
    pipelineZremrangebyrank.mockReset();
    pipelineZcard.mockReset();
    redisMock.info.mockReset();
    trimMetric.inc.mockReset();
    zsetSizeMetric.observe.mockReset();
    guardMetric.inc.mockReset();
    loggerWarn.mockReset();
    process.env.WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED = "true";
    process.env.WS_REPLAY_PENDING_MEMORY_GUARD_PCT = "85";
    process.env.WS_REPLAY_PENDING_USER_MAX_ZSET = "100";
    process.env.WS_REPLAY_PENDING_ONLY_ACTIVE = "false";
    process.env.WS_REPLAY_PENDING_LEGACY_ALL = "false";
  });

  it("trims per-user pending zset and records metrics", async () => {
    redisMock.info.mockResolvedValue("used_memory:100\nmaxmemory:1000\n");
    pipelineExec.mockResolvedValue([
      [null, "OK"], // set pending message
      [null, 1],    // zadd
      [null, 1],    // expire
      [null, 3],    // zremrangebyrank (trimmed)
      [null, 100],  // zcard
    ]);
    const { enqueuePendingMessageForUsers } = require("../src/messages/realtimePending");
    await enqueuePendingMessageForUsers(["user:u1"], {
      event: "message:created",
      data: { id: "m1", channel_id: "ch1" },
    });
    expect(redisMock.pipeline).toHaveBeenCalledTimes(1);
    expect(pipelineZremrangebyrank).toHaveBeenCalledWith("ws:pending:user:u1", 0, -101);
    expect(trimMetric.inc).toHaveBeenCalledWith(3);
    expect(zsetSizeMetric.observe).toHaveBeenCalledWith(100);
  });

  it("skips pending replay writes when memory guard is active", async () => {
    redisMock.info.mockResolvedValue("used_memory:910\nmaxmemory:1000\n");
    const { enqueuePendingMessageForUsers } = require("../src/messages/realtimePending");
    await enqueuePendingMessageForUsers(["user:u1"], {
      event: "message:created",
      data: { id: "m2", channel_id: "ch2" },
    });
    expect(guardMetric.inc).toHaveBeenCalledWith({ reason: "redis_memory_high" });
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });
});

