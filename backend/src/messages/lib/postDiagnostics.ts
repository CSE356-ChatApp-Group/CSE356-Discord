/**
 * POST /messages diagnostics: timeout classification, 503 bodies, phase logs, optional e2e trace payload.
 */


const os = require("os");

/** PgBouncer `query_timeout` or PG `statement_timeout` during insert (often row lock behind channels FK). */
function isMessagePostInsertDbTimeout(err: unknown) {
  if (!err) return false;
  const e = err as { message?: string; code?: string };
  const msg = String(e.message || "");
  const code = e.code;
  if (code === "57014") return true;
  if (/query timeout/i.test(msg)) return true;
  if (/statement timeout/i.test(msg)) return true;
  if (/canceling statement due to statement timeout/i.test(msg)) return true;
  if (code === "08P01" && /timeout/i.test(msg)) return true;
  return false;
}

const MESSAGE_POST_BUSY_USER_MESSAGE =
  "Messaging is briefly busy saving your message; please retry.";

/** Stable `code` values on POST /messages 503 JSON for operators and clients (human `error` unchanged). */
function messagePostBusy503Body(
  req: { id?: string },
  apiCode:
    | "message_post_insert_timeout"
    | "message_insert_lock_wait_timeout"
    | "message_insert_lock_recent_shed"
    | "message_insert_lock_waiter_cap",
  extras: Record<string, unknown> = {},
) {
  return {
    error: MESSAGE_POST_BUSY_USER_MESSAGE,
    code: apiCode,
    requestId: req.id,
    ...extras,
  };
}

function buildMessagePostTimeoutPhaseLog({
  err,
  req,
  channelId,
  conversationId,
  attachments,
  txPhases,
}: {
  err: any;
  req: any;
  channelId: string | null;
  conversationId: string | null;
  attachments: Array<unknown>;
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
}) {
  const now = Date.now();
  const hadAttachments = attachments.length > 0;
  const reachedAccess = txPhases.t_access > 0;
  const reachedInsert = txPhases.t_insert > 0;
  const reachedLater = txPhases.t_later > 0;
  let timeoutPhase: "access-check" | "insert" | "later-step" | "commit" =
    "access-check";
  let tx_access_check_ms: number | null = null;
  let tx_insert_ms: number | null = null;
  let tx_later_step_ms: number | null = null;
  let tx_commit_ms: number | null = null;

  if (!reachedAccess) {
    tx_access_check_ms = Math.max(0, now - txPhases.t0);
  } else if (!reachedInsert) {
    timeoutPhase = "insert";
    tx_access_check_ms = Math.max(0, txPhases.t_access - txPhases.t0);
    tx_insert_ms = Math.max(0, now - txPhases.t_access);
  } else if (!reachedLater) {
    timeoutPhase = "later-step";
    tx_access_check_ms = Math.max(0, txPhases.t_access - txPhases.t0);
    tx_insert_ms = Math.max(0, txPhases.t_insert - txPhases.t_access);
    tx_later_step_ms = Math.max(0, now - txPhases.t_insert);
  } else {
    timeoutPhase = "commit";
    tx_access_check_ms = Math.max(0, txPhases.t_access - txPhases.t0);
    tx_insert_ms = Math.max(0, txPhases.t_insert - txPhases.t_access);
    tx_later_step_ms = Math.max(0, txPhases.t_later - txPhases.t_insert);
    tx_commit_ms = Math.max(0, now - txPhases.t_later);
  }

  return {
    event: "post_messages_tx_timeout_phases",
    gradingNote: "correlate_with_post_messages_timeout",
    requestId: req.id,
    instance: `${os.hostname()}:${process.env.PORT || "unknown"}`,
    targetType: channelId ? "channel" : "conversation",
    channelId: channelId ?? undefined,
    conversationId: conversationId ?? undefined,
    timeoutPhase,
    tx_access_check_ms,
    tx_insert_ms,
    tx_later_step_ms,
    tx_commit_ms,
    hadAttachments,
    pgCode: err?.code,
    pgMessage: err?.message,
  };
}

function buildMessagePostSuccessPhaseLog({
  req,
  channelId,
  conversationId,
  attachments,
  txPhases,
  txDoneAt,
}: {
  req: any;
  channelId: string | null;
  conversationId: string | null;
  attachments: Array<unknown>;
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
  txDoneAt: number;
}) {
  const tx_total_ms = txDoneAt - txPhases.t0;
  return {
    event: "post_messages_tx_phases",
    gradingNote: "correlate_with_post_messages_timeout",
    requestId: req.id,
    channelId: channelId ?? undefined,
    conversationId: conversationId ?? undefined,
    targetType: channelId ? "channel" : "conversation",
    tx_access_check_ms: txPhases.t_access - txPhases.t0,
    tx_insert_ms: txPhases.t_insert - txPhases.t_access,
    tx_later_step_ms: txPhases.t_later - txPhases.t_insert,
    tx_commit_ms: txDoneAt - txPhases.t_later,
    tx_total_ms,
    had_attachments: attachments.length > 0,
  };
}

function buildMessagePostSlowHolderLog({
  req,
  channelId,
  message,
  txLog,
  postInsertMs,
  postInsertBreakdown,
  fanoutMeta,
  cacheHit,
  searchIndexingTriggered,
  readStatesWriteTriggered,
}: {
  req: any;
  channelId: string | null;
  message: any;
  txLog: any;
  postInsertMs: number;
  postInsertBreakdown: {
    cache_bust_ms: number;
    fanout_publish_ms: number;
    side_effects_enqueue_ms: number;
    idempotency_cache_ms: number;
    response_build_ms: number;
  };
  fanoutMeta: any;
  cacheHit: boolean | null;
  searchIndexingTriggered: boolean;
  readStatesWriteTriggered: boolean;
}) {
  const preInsertMs = Number(txLog.tx_access_check_ms || 0);
  const insertMs = Number(txLog.tx_insert_ms || 0);
  const txCommitMs = Number(txLog.tx_commit_ms || 0);
  const txTotalMs = Number(txLog.tx_total_ms || 0);
  const postMs = Math.max(0, Number(postInsertMs || 0));
  const messageSizeBytes =
    Buffer.byteLength(String(message?.content || ""), "utf8") +
    Number((Array.isArray(message?.attachments) ? message.attachments : []).reduce(
      (sum: number, a: any) => sum + Number(a?.size_bytes || a?.sizeBytes || 0),
      0,
    ));
  const phases = [
    { phase: "pre_insert_work", ms: preInsertMs },
    { phase: "db_insert", ms: insertMs },
    { phase: "post_insert_work", ms: postMs },
  ];
  phases.sort((a, b) => b.ms - a.ms);
  return {
    event: "post_messages_lock_holder_slow",
    requestId: req.id,
    channelId: channelId ?? undefined,
    messageId: message?.id,
    message_size_bytes: messageSizeBytes,
    tx_total_ms: txTotalMs,
    tx_commit_ms: txCommitMs,
    time_before_insert_ms: preInsertMs,
    time_inside_insert_ms: insertMs,
    time_after_insert_ms: postMs,
    dominant_holder_phase: phases[0]?.phase || "unknown",
    fanout_count:
      Number(fanoutMeta?.totalTargetCount) ||
      Number(fanoutMeta?.inlineTargetCount) ||
      0,
    fanout_cache_result: fanoutMeta?.cacheResult || "unknown",
    fanout_cache_hit: cacheHit,
    fanout_mode: fanoutMeta?.mode || "unknown",
    search_indexing_triggered: searchIndexingTriggered,
    read_states_write_triggered: readStatesWriteTriggered,
    post_insert_breakdown_ms: postInsertBreakdown,
  };
}

function parseNonNegIntOr(name: string, fallback: number) {
  const v = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function parseUnitIntervalOr(name: string, fallback: number) {
  const v = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}
/** Emit `post_messages_e2e_trace` when wall time >= this ms (0 = disabled). */
const MESSAGE_POST_E2E_TRACE_MIN_MS = parseNonNegIntOr(
  "MESSAGE_POST_E2E_TRACE_MIN_MS",
  0,
);
/** Random sample of successful POSTs (e.g. 0.01 ~= 1%). Independent of min ms. */
const MESSAGE_POST_E2E_TRACE_SAMPLE_RATE = parseUnitIntervalOr(
  "MESSAGE_POST_E2E_TRACE_SAMPLE_RATE",
  0,
);

function shouldEmitPostMessagesE2eTrace(totalWallMs: number) {
  if (MESSAGE_POST_E2E_TRACE_MIN_MS > 0 && totalWallMs >= MESSAGE_POST_E2E_TRACE_MIN_MS) {
    return true;
  }
  if (
    MESSAGE_POST_E2E_TRACE_SAMPLE_RATE > 0 &&
    Math.random() < MESSAGE_POST_E2E_TRACE_SAMPLE_RATE
  ) {
    return true;
  }
  return false;
}

function buildPostMessagesE2eTracePayload(args: Record<string, any>) {
  const {
    req,
    channelId,
    conversationId,
    postWallStart,
    txPhases,
    total_wall_ms,
    idem_redis_ms,
    channel_insert_lock_wait_ms,
    channel_insert_lock_path,
    channel_insert_lock_reason_detail,
    successLog,
    hydrate_ms,
    cache_bust_ms,
    fanout_wall_ms,
    fanout_mode,
    community_enqueue_ms,
    idem_success_redis_ms,
    serialization_ms,
    response_body_bytes,
  } = args;
  const txAccess = Math.max(0, Number(successLog.tx_access_check_ms || 0));
  const txInsert = Math.max(0, Number(successLog.tx_insert_ms || 0));
  const txLater = Math.max(0, Number(successLog.tx_later_step_ms || 0));
  const txCommit = Math.max(0, Number(successLog.tx_commit_ms || 0));
  const txTotal = Math.max(0, Number(successLog.tx_total_ms || 0));
  const preDbHeadMs =
    txPhases.t0 > 0 && postWallStart > 0
      ? Math.max(0, txPhases.t0 - postWallStart)
      : 0;
  const preDbOtherMs = Math.max(
    0,
    preDbHeadMs - idem_redis_ms - channel_insert_lock_wait_ms,
  );
  const breakdown = {
    idem_redis_ms,
    channel_insert_lock_wait_ms,
    pre_db_other_ms: preDbOtherMs,
    tx_access_check_ms: txAccess,
    tx_insert_ms: txInsert,
    tx_later_step_ms: txLater,
    tx_commit_ms: txCommit,
    hydrate_ms,
    cache_bust_ms,
    fanout_wall_ms,
    community_enqueue_ms,
    idem_success_redis_ms,
    serialization_ms,
  };
  const accounted =
    idem_redis_ms +
    channel_insert_lock_wait_ms +
    preDbOtherMs +
    txAccess +
    txInsert +
    txLater +
    txCommit +
    hydrate_ms +
    cache_bust_ms +
    fanout_wall_ms +
    community_enqueue_ms +
    idem_success_redis_ms +
    serialization_ms;
  const other_unaccounted_ms = Math.max(0, total_wall_ms - accounted);
  const candidates = {
    ...breakdown,
    other_unaccounted_ms,
  };
  let dominant_component = "other_unaccounted_ms";
  let dominant_ms = other_unaccounted_ms;
  for (const [k, v] of Object.entries(candidates)) {
    const ms = typeof v === "number" ? v : 0;
    if (ms > dominant_ms) {
      dominant_ms = ms;
      dominant_component = k;
    }
  }
  /** Map breakdown field to coarse bucket for rollups (DB vs Redis vs serialization vs other). */
  const dominant_bucket = (() => {
    const d = dominant_component;
    if (
      d === "tx_access_check_ms" ||
      d === "tx_insert_ms" ||
      d === "tx_later_step_ms" ||
      d === "tx_commit_ms"
    ) {
      return "db";
    }
    if (
      d === "idem_redis_ms" ||
      d === "channel_insert_lock_wait_ms" ||
      d === "cache_bust_ms" ||
      d === "fanout_wall_ms" ||
      d === "idem_success_redis_ms" ||
      d === "community_enqueue_ms"
    ) {
      return "redis";
    }
    if (d === "serialization_ms") return "serialization";
    if (d === "hydrate_ms") return "hydrate_db";
    return "other";
  })();
  return {
    event: "post_messages_e2e_trace",
    gradingNote: "rollup_dominant_component_and_dominant_bucket_in_log_pipeline",
    requestId: req.id,
    worker_id: `${os.hostname()}:${process.env.PORT || "?"}`,
    target_type: channelId ? "channel" : "conversation",
    channelId: channelId ?? undefined,
    conversationId: conversationId ?? undefined,
    total_wall_ms,
    tx_total_ms: txTotal,
    fanout_mode,
    breakdown_ms: { ...breakdown, other_unaccounted_ms },
    dominant_component,
    dominant_ms,
    dominant_bucket,
    response_body_bytes,
    correlate_redis_slowlog:
      "REDIS_SLOWLOG_SSH=user@vm1 ./scripts/redis/redis-slowlog-snapshot.sh (see docs/operations-monitoring.md)",
    correlate_pg_stat_statements:
      "DB_SSH=user@db-host ./scripts/postgres/pg-stat-statements-snapshot.sh",
    ...(channel_insert_lock_path != null
      ? { channel_insert_lock_path: channel_insert_lock_path }
      : {}),
    ...(channel_insert_lock_reason_detail != null
      ? { channel_insert_lock_reason_detail: channel_insert_lock_reason_detail }
      : {}),
  };
}

module.exports = {
  isMessagePostInsertDbTimeout,
  messagePostBusy503Body,
  buildMessagePostTimeoutPhaseLog,
  buildMessagePostSuccessPhaseLog,
  buildMessagePostSlowHolderLog,
  shouldEmitPostMessagesE2eTrace,
  buildPostMessagesE2eTracePayload,
};
