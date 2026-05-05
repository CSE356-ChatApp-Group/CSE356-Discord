/**
 * @jest-environment node
 */

jest.mock("../src/db/redis", () => ({
  get: jest.fn(),
  mget: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  unlink: jest.fn(),
  smembers: jest.fn().mockResolvedValue([]),
  eval: jest.fn(),
  pipeline: jest.fn(() => ({
    set: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    hset: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../src/websocket/userFeed", () => ({
  publishUserFeedTargets: jest.fn(),
}));

jest.mock("../src/db/pool", () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock("../src/utils/overload", () => ({
  shouldThrottlePresenceFanout: jest.fn(() => false),
  shouldSkipPresenceMirror: jest.fn(() => true),
}));

jest.mock("../src/utils/logger", () => ({
  debug: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("../src/utils/metrics", () => ({
  presenceFanoutTotal: { inc: jest.fn() },
  presenceFanoutTargetsInvalidationTotal: { inc: jest.fn() },
  presenceFanoutTargetsInvalidationKeysTotal: { inc: jest.fn() },
  presenceFanoutTargetsInvalidationDurationMs: { observe: jest.fn() },
}));

jest.mock("../src/messages/messageInsertLockPressure", () => ({
  getShouldDeferReadReceiptForInsertLockPressure: jest.fn(() => false),
}));

const redis = require("../src/db/redis") as {
  get: jest.Mock;
  del: jest.Mock;
  unlink: jest.Mock;
  set: jest.Mock;
  mget: jest.Mock;
};
const pool = require("../src/db/pool") as { query: jest.Mock };
const { publishUserFeedTargets } = require("../src/websocket/userFeed") as {
  publishUserFeedTargets: jest.Mock;
};
const metrics = require("../src/utils/metrics") as {
  presenceFanoutTargetsInvalidationTotal: { inc: jest.Mock };
  presenceFanoutTargetsInvalidationKeysTotal: { inc: jest.Mock };
};

const {
  invalidatePresenceFanoutTargets,
  invalidatePresenceFanoutTargetsBulk,
  setPresence,
} = require("../src/presence/service") as {
  invalidatePresenceFanoutTargets: (userId: string) => Promise<void>;
  invalidatePresenceFanoutTargetsBulk: (userIds: string[]) => Promise<void>;
  setPresence: (
    userId: string,
    status: string,
    awayMessage?: string | null,
  ) => Promise<void>;
};

function uuid(i: number) {
  const hex = i.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

describe("presence fanout_targets cache invalidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.unlink.mockResolvedValue(1);
    redis.del.mockResolvedValue(1);
    // restore unlink if a test removed it
    if (!redis.unlink) {
      (redis as any).unlink = jest.fn().mockResolvedValue(1);
    }
  });

  it("bulk: empty input performs no Redis unlink/del", async () => {
    await invalidatePresenceFanoutTargetsBulk([]);
    expect(redis.unlink).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(
      metrics.presenceFanoutTargetsInvalidationKeysTotal.inc,
    ).not.toHaveBeenCalled();
  });

  it("bulk: duplicate userIds are de-duped to one unlink call", async () => {
    const u = uuid(1);
    await invalidatePresenceFanoutTargetsBulk([u, u, u]);
    expect(redis.unlink).toHaveBeenCalledTimes(1);
    expect(redis.unlink).toHaveBeenCalledWith(`presence:${u}:fanout_targets`);
    expect(
      metrics.presenceFanoutTargetsInvalidationKeysTotal.inc,
    ).toHaveBeenCalledWith({ mode: "bulk" }, 1);
  });

  it("bulk: <=50 unique keys triggers one unlink", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => uuid(i));
    await invalidatePresenceFanoutTargetsBulk(ids);
    expect(redis.unlink).toHaveBeenCalledTimes(1);
    expect(redis.unlink.mock.calls[0].length).toBe(50);
    expect(
      metrics.presenceFanoutTargetsInvalidationTotal.inc,
    ).toHaveBeenCalledWith({ mode: "bulk", command: "unlink" }, 1);
  });

  it("bulk: >50 keys triggers multiple unlink chunks", async () => {
    const ids = Array.from({ length: 110 }, (_, i) => uuid(i));
    await invalidatePresenceFanoutTargetsBulk(ids);
    expect(redis.unlink).toHaveBeenCalledTimes(3);
    expect(redis.unlink.mock.calls[0].length).toBe(50);
    expect(redis.unlink.mock.calls[1].length).toBe(50);
    expect(redis.unlink.mock.calls[2].length).toBe(10);
    expect(
      metrics.presenceFanoutTargetsInvalidationTotal.inc,
    ).toHaveBeenCalledTimes(3);
    expect(
      metrics.presenceFanoutTargetsInvalidationKeysTotal.inc,
    ).toHaveBeenCalledWith({ mode: "bulk" }, 110);
  });

  it("bulk: falls back to del when unlink is unavailable", async () => {
    const saved = redis.unlink;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (redis as any).unlink;

    const ids = [uuid(1), uuid(2)];
    await invalidatePresenceFanoutTargetsBulk(ids);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(
      `presence:${ids[0]}:fanout_targets`,
      `presence:${ids[1]}:fanout_targets`,
    );
    expect(
      metrics.presenceFanoutTargetsInvalidationTotal.inc,
    ).toHaveBeenCalledWith({ mode: "bulk", command: "del_fallback" }, 1);

    (redis as any).unlink = saved;
  });

  it("single: invalidatePresenceFanoutTargets removes expected key via unlink", async () => {
    const u = uuid(99);
    await invalidatePresenceFanoutTargets(u);
    expect(redis.unlink).toHaveBeenCalledTimes(1);
    expect(redis.unlink).toHaveBeenCalledWith(`presence:${u}:fanout_targets`);
    expect(
      metrics.presenceFanoutTargetsInvalidationTotal.inc,
    ).toHaveBeenCalledWith({ mode: "single", command: "unlink" }, 1);
  });

  it("setPresence: corrupt fanout cache triggers single-key unlink before DB reload", async () => {
    const actor = uuid(7);
    redis.mget.mockResolvedValueOnce([null, null]);
    redis.get.mockResolvedValueOnce("not-json");
    pool.query.mockResolvedValueOnce({ rows: [{ user_id: uuid(8) }] });
    redis.set.mockResolvedValueOnce("OK");

    await setPresence(actor, "online");

    expect(redis.unlink).toHaveBeenCalledWith(
      `presence:${actor}:fanout_targets`,
    );
    expect(pool.query).toHaveBeenCalled();
    expect(publishUserFeedTargets).toHaveBeenCalled();
  });
});
