/**
 * POST /messages e2e trace rollup: fanout vs cache bust attribution (no HTTP behavior).
 */

const { computePostMessagesE2eRollup } = require("../src/messages/lib/postDiagnostics");

function baseRollup(overrides: Record<string, number> = {}) {
  const d = {
    /** Match accounted sum so other_unaccounted does not dominate tests. */
    total_wall_ms: 168,
    idem_redis_ms: 0,
    channel_insert_lock_wait_ms: 0,
    pre_db_other_ms: 0,
    tx_access_check_ms: 10,
    tx_insert_ms: 40,
    tx_later_step_ms: 0,
    tx_commit_ms: 5,
    hydrate_ms: 15,
    fanout_enqueue_wall_ms: 2,
    recent_bridge_wall_ms: 5,
    fanout_wall_ms: 80,
    cache_bust_only_ms: 30,
    post_hydrate_parallel_wall_ms: 85,
    community_enqueue_ms: 1,
    idem_success_redis_ms: 2,
    serialization_ms: 10,
    ...overrides,
  };
  return computePostMessagesE2eRollup(d);
}

describe("computePostMessagesE2eRollup", () => {
  it("picks fanout_wall_ms as dominant when fanout wall exceeds cache bust only", () => {
    const r = baseRollup({
      fanout_wall_ms: 120,
      cache_bust_only_ms: 25,
      post_hydrate_parallel_wall_ms: 120,
      total_wall_ms: 203,
    });
    expect(r.dominant_component).toBe("fanout_wall_ms");
    expect(r.dominant_bucket).toBe("fanout");
  });

  it("picks cache_bust_only_ms as dominant when cache bust exceeds fanout wall", () => {
    const r = baseRollup({
      fanout_wall_ms: 20,
      cache_bust_only_ms: 90,
      post_hydrate_parallel_wall_ms: 90,
      total_wall_ms: 173,
    });
    expect(r.dominant_component).toBe("cache_bust_only_ms");
    expect(r.dominant_bucket).toBe("redis_cache_bust");
  });

  it("does not classify cache bust dominant as generic redis", () => {
    const r = baseRollup({
      fanout_wall_ms: 10,
      cache_bust_only_ms: 200,
      post_hydrate_parallel_wall_ms: 200,
      total_wall_ms: 283,
    });
    expect(r.dominant_bucket).not.toBe("redis");
    expect(r.dominant_bucket).toBe("redis_cache_bust");
  });

  it("counts post_hydrate_parallel_wall_ms once in accounted (not fanout+bust+parallel)", () => {
    const r = baseRollup({
      fanout_wall_ms: 80,
      cache_bust_only_ms: 30,
      post_hydrate_parallel_wall_ms: 85,
      total_wall_ms: 168,
    });
    const sumPhases =
      r.breakdown.idem_redis_ms +
      r.breakdown.channel_insert_lock_wait_ms +
      r.breakdown.pre_db_other_ms +
      r.breakdown.tx_access_check_ms +
      r.breakdown.tx_insert_ms +
      r.breakdown.tx_later_step_ms +
      r.breakdown.tx_commit_ms +
      r.breakdown.hydrate_ms +
      r.breakdown.post_hydrate_parallel_wall_ms +
      r.breakdown.community_enqueue_ms +
      r.breakdown.idem_success_redis_ms +
      r.breakdown.serialization_ms;
    expect(r.accounted).toBe(sumPhases);
    expect(r.breakdown.post_hydrate_parallel_wall_ms).toBeLessThan(
      r.breakdown.fanout_wall_ms + r.breakdown.cache_bust_only_ms,
    );
  });

  it("legacy cache_bust_ms equals post_hydrate_parallel_wall_ms for dashboards", () => {
    const r = baseRollup({ post_hydrate_parallel_wall_ms: 92, total_wall_ms: 175 });
    expect(r.breakdown.cache_bust_ms).toBe(92);
    expect(r.breakdown.cache_bust_ms).toBe(r.breakdown.post_hydrate_parallel_wall_ms);
  });

  it("hydrate_db_ms mirrors hydrate_ms", () => {
    const r = baseRollup({ hydrate_ms: 33 });
    expect(r.breakdown.hydrate_db_ms).toBe(33);
  });

  it("old bug: fanout_wall would be 0 if computed as t_fanout_end - t_cache_bust_end", () => {
    const fanoutWallWrong = Math.max(0, 100 - 150);
    expect(fanoutWallWrong).toBe(0);
    const r = baseRollup({
      fanout_wall_ms: 50,
      cache_bust_only_ms: 40,
      post_hydrate_parallel_wall_ms: 70,
      total_wall_ms: 153,
    });
    expect(r.dominant_component).toBe("fanout_wall_ms");
    expect(r.breakdown.fanout_wall_ms).toBeGreaterThan(0);
  });
});
