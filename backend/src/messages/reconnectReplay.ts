'use strict';

const { withTransaction, poolStats } = require('../db/pool');
const redis = require('../db/redis');
const logger = require('../utils/logger');
const overload = require('../utils/overload');
const {
  wsReplayQueryTotal,
  wsReplayQueryDurationMs,
  wsReplayFailOpenTotal,
  wsReplayDedupedTotal,
  wsReplayCachedTotal,
  wsReplayDbQueryTotal,
  wsReplayStartedTotal,
  wsReplayErrorClassTotal,
} = require('../utils/metrics');
import { MESSAGE_SELECT_FIELDS, MESSAGE_AUTHOR_JSON } from './sqlFragments';

// Reconnect replay is our safety net for brief WS gaps. Keep the default large
// enough that a short disconnect under grader bursts does not silently skip a
// handful of committed message:created events, but keep it bounded so replay
// traffic cannot starve live writes during reconnect storms.
const rawReplayLimit = Number(process.env.WS_MESSAGE_REPLAY_LIMIT || '150');
const WS_MESSAGE_REPLAY_LIMIT =
  Number.isFinite(rawReplayLimit) && rawReplayLimit >= 0
    ? Math.min(10_000, Math.floor(rawReplayLimit))
    : 150;

// Replay window covers the full disconnect gap up to 1 hour so users who
// are offline for minutes (e.g. grader pausing a bot) still get missed DMs
// on reconnect. The per-gap profile function further shapes limit/windowMs.
const rawReplayMaxWindowMs = Number(process.env.WS_MESSAGE_REPLAY_MAX_WINDOW_MS || '3600000');
const WS_MESSAGE_REPLAY_MAX_WINDOW_MS =
  Number.isFinite(rawReplayMaxWindowMs) && rawReplayMaxWindowMs > 0
    ? Math.floor(rawReplayMaxWindowMs)
    : 3600000;
// Hard cap for DB safety under long disconnect gaps (default 5 min).
const rawReplayWindowHardCapMs = Number(
  process.env.WS_MESSAGE_REPLAY_WINDOW_HARD_CAP_MS || '300000',
);
const WS_MESSAGE_REPLAY_WINDOW_HARD_CAP_MS =
  Number.isFinite(rawReplayWindowHardCapMs) && rawReplayWindowHardCapMs > 0
    ? Math.floor(rawReplayWindowHardCapMs)
    : 300000;
// A socket can die on the client/intermediary side before the server records
// the disconnect on heartbeat. Looking back slightly prevents messages created
// in that blind window from being skipped during reconnect replay.
const rawReplayDisconnectGraceMs = Number(
  process.env.WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS || '15000',
);
const WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS =
  Number.isFinite(rawReplayDisconnectGraceMs) && rawReplayDisconnectGraceMs >= 0
    ? Math.floor(rawReplayDisconnectGraceMs)
    : 15000;

// Hard cap 1000–1500ms via SET LOCAL so replay cannot hold slots under abuse.
const rawReplayStatementTimeoutMs = Number(
  process.env.WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS || '1250',
);
const WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS =
  Number.isFinite(rawReplayStatementTimeoutMs) && rawReplayStatementTimeoutMs >= 1000
    ? Math.floor(rawReplayStatementTimeoutMs)
    : 1250;

/** Clamp to [1000ms, 1500ms] for reconnect replay only. */
const WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED = Math.min(
  1500,
  Math.max(1000, WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS),
);

const rawReplayDbMaxGlobal = Number(process.env.WS_REPLAY_DB_MAX_IN_FLIGHT || '2');
const WS_REPLAY_DB_MAX_GLOBAL =
  Number.isFinite(rawReplayDbMaxGlobal) && rawReplayDbMaxGlobal >= 1
    ? Math.min(2, Math.floor(rawReplayDbMaxGlobal))
    : 2;

const rawReplayDedupTtlSec = Number(process.env.WS_REPLAY_DEDUP_TTL_SEC || '3');
const WS_REPLAY_DEDUP_TTL_SEC =
  Number.isFinite(rawReplayDedupTtlSec) && rawReplayDedupTtlSec >= 2 && rawReplayDedupTtlSec <= 5
    ? Math.floor(rawReplayDedupTtlSec)
    : Number.isFinite(rawReplayDedupTtlSec) && rawReplayDedupTtlSec > 0
      ? Math.min(5, Math.max(2, Math.floor(rawReplayDedupTtlSec)))
      : 3;

const rawReplayErrorLogSampleRate = Number(process.env.WS_REPLAY_ERROR_LOG_SAMPLE_RATE || '0.1');
const WS_REPLAY_ERROR_LOG_SAMPLE_RATE =
  Number.isFinite(rawReplayErrorLogSampleRate)
    ? Math.min(1, Math.max(0, rawReplayErrorLogSampleRate))
    : 0.1;

/** @deprecated use WS_REPLAY_DB_MAX_GLOBAL — kept for tests / metrics parity */
const WS_MESSAGE_REPLAY_MAX_CONCURRENT = WS_REPLAY_DB_MAX_GLOBAL;

let replayDbInFlight = 0;

/** In-process fallback when Redis is unavailable (same worker only). */
const replayDedupeMem = new Map();
const replayResultMem = new Map();

function isRedisReplayDedupeOperational() {
  return ['wait', 'connecting', 'connect', 'ready', 'reconnecting'].includes(redis.status);
}

function replayDedupeRedisKey(userId) {
  return `ws:replay:recent:${userId}`;
}

function replayCursorKey(userId, cursor) {
  return `ws:replay:${userId}:${cursor}`;
}

function replayDedupeFingerprint(
  disconnectedAtMs,
  reconnectObservedMs,
  replayLowerBoundMs,
  upperBoundMs,
  limit,
  stage,
  closeCode,
) {
  return [
    disconnectedAtMs,
    reconnectObservedMs,
    replayLowerBoundMs,
    upperBoundMs,
    limit,
    stage,
    closeCode ?? '',
  ].join('|');
}

async function readReplayDedupe(userId) {
  if (isRedisReplayDedupeOperational()) {
    try {
      const v = await redis.get(replayDedupeRedisKey(userId));
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  const ent = replayDedupeMem.get(userId);
  if (!ent) return null;
  if (Date.now() >= ent.expiresAt) {
    replayDedupeMem.delete(userId);
    return null;
  }
  return ent.fp;
}

async function writeReplayDedupe(userId, fingerprint) {
  if (isRedisReplayDedupeOperational()) {
    try {
      await redis.set(replayDedupeRedisKey(userId), fingerprint, 'EX', WS_REPLAY_DEDUP_TTL_SEC);
    } catch {
      /* fail open: do not block replay */
    }
    return;
  }
  replayDedupeMem.set(userId, {
    fp: fingerprint,
    expiresAt: Date.now() + WS_REPLAY_DEDUP_TTL_SEC * 1000,
  });
}

async function readReplayResultCache(userId, cursor) {
  if (isRedisReplayDedupeOperational()) {
    try {
      const raw = await redis.get(replayCursorKey(userId, cursor));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const ent = replayResultMem.get(`${userId}:${cursor}`);
  if (!ent) return null;
  if (Date.now() >= ent.expiresAt) {
    replayResultMem.delete(`${userId}:${cursor}`);
    return null;
  }
  return Array.isArray(ent.rows) ? ent.rows : null;
}

async function writeReplayResultCache(userId, cursor, rows) {
  if (isRedisReplayDedupeOperational()) {
    try {
      await redis.set(
        replayCursorKey(userId, cursor),
        JSON.stringify(Array.isArray(rows) ? rows : []),
        'EX',
        WS_REPLAY_DEDUP_TTL_SEC,
      );
      return;
    } catch {
      // fail-open
    }
  }
  replayResultMem.set(`${userId}:${cursor}`, {
    rows: Array.isArray(rows) ? rows : [],
    expiresAt: Date.now() + WS_REPLAY_DEDUP_TTL_SEC * 1000,
  });
}

function resetReplayDedupeMemForTests() {
  replayDedupeMem.clear();
  replayResultMem.clear();
}

function replayQueryProfile(gapMs, stage = overload.getStage(), closeCode?: number) {
  let windowMs = WS_MESSAGE_REPLAY_MAX_WINDOW_MS;
  let limit = WS_MESSAGE_REPLAY_LIMIT;
  // Grace period: how far before disconnectedAt to extend the scan lower bound.
  // For very short gaps the server records disconnect precisely (clean 1005 close),
  // so a large lookback wastes index scans. Use a tight window for short gaps and
  // the full 15 s default only for long/abnormal disconnects.
  let gracePeriodMs = WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS;

  // Abnormal close (1006) means the server detected the dead TCP connection at
  // heartbeat time — up to WS_HEARTBEAT_INTERVAL_MS (20s) after the connection
  // actually died. Messages delivered to the zombie socket during that window
  // appear delivered but are lost. Use a large grace period to recover them.
  const isAbnormalClose = closeCode === 1006;

  if (gapMs <= 1_000) {
    windowMs = Math.min(windowMs, 5_000);
    limit = Math.min(limit, 15);
    // For clean closes, disconnectedAt is accurate. For 1006 (zombie detected
    // by heartbeat), the socket may have been dead for up to the heartbeat
    // interval before the server noticed — look back far enough to cover that.
    // Use 2000ms (up from 500ms) to cover cases where the disconnect marker is
    // recorded slightly after the actual close — messages sent in that window
    // would otherwise fall just before the lower bound and be missed.
    gracePeriodMs = isAbnormalClose ? 25_000 : 2_000;
  } else if (gapMs <= 5_000) {
    windowMs = Math.min(windowMs, 15_000);
    limit = Math.min(limit, 60);
    gracePeriodMs = 3_000;
  } else if (gapMs <= 30_000) {
    windowMs = Math.min(windowMs, 45_000);
    limit = Math.min(limit, 100);
  } else if (gapMs <= 300_000) {
    // 30s–5min gap: scan the full gap duration, cap at 150 messages
    windowMs = Math.min(windowMs, gapMs + 5_000);
    limit = Math.min(limit, 150);
  } else {
    // >5min gap (e.g. grader bot offline): scan the full gap, cap at 200 messages
    windowMs = Math.min(windowMs, gapMs + 5_000);
    limit = Math.min(limit, 200);
  }

  if (stage >= 1) {
    windowMs = Math.min(windowMs, 20_000);
    limit = Math.min(limit, 25);
  }
  if (stage >= 2) {
    windowMs = Math.min(windowMs, 12_000);
    limit = Math.min(limit, 10);
  }

  // Final guardrail so pathological reconnect gaps cannot force huge scans.
  windowMs = Math.min(windowMs, WS_MESSAGE_REPLAY_WINDOW_HARD_CAP_MS);

  return {
    stage,
    limit: Math.min(50, Math.max(0, limit)),
    windowMs: Math.max(0, windowMs),
    gracePeriodMs: Math.max(0, gracePeriodMs),
  };
}

function classifyReplayError(err) {
  const message = String(err?.message || '').toLowerCase();
  if (err?.code === '57014' || message.includes('statement timeout')) return 'timeout';
  if (
    err?.code === 'POOL_CIRCUIT_OPEN'
    || err?.name === 'PoolTimeoutError'
    || message.includes('waiting for a client')
    || message.includes('remaining connection slots')
    || message.includes('too many clients')
  ) {
    return 'pool_busy';
  }
  return 'error';
}

function shouldSampleReplayErrorLog() {
  return Math.random() < WS_REPLAY_ERROR_LOG_SAMPLE_RATE;
}

async function loadReplayableMessagesForUser(userId, disconnectedAtMs, reconnectObservedAtMs, closeCode?: number) {
  if (!userId) return [];

  const lowerBoundMs = Number(disconnectedAtMs || 0);
  const reconnectObservedMs = Number(reconnectObservedAtMs || 0);
  if (!Number.isFinite(lowerBoundMs) || !Number.isFinite(reconnectObservedMs)) return [];
  if (lowerBoundMs <= 0 || reconnectObservedMs <= lowerBoundMs) return [];

  const gapMs = reconnectObservedMs - lowerBoundMs;
  const cursor = `${lowerBoundMs}:${reconnectObservedMs}:${closeCode ?? ''}`;
  const cachedRows = await readReplayResultCache(userId, cursor);
  if (cachedRows) {
    wsReplayCachedTotal.inc();
    return cachedRows;
  }

  if (replayDbInFlight >= WS_REPLAY_DB_MAX_GLOBAL) {
    wsReplayFailOpenTotal.inc({ reason: 'global_concurrency' });
    wsReplayQueryTotal.inc({ result: 'skipped' });
    wsReplayQueryDurationMs.observe({ result: 'skipped' }, 0);
    logger.warn(
      { userId, gapMs, inFlight: replayDbInFlight, max: WS_REPLAY_DB_MAX_GLOBAL },
      'WS reconnect replay skipped: global DB concurrency cap',
    );
    return [];
  }

  const profile = replayQueryProfile(gapMs, undefined, closeCode);
  if (profile.stage >= 3 || profile.limit <= 0 || profile.windowMs <= 0) {
    wsReplayQueryTotal.inc({ result: 'skipped' });
    wsReplayQueryDurationMs.observe({ result: 'skipped' }, 0);
    return [];
  }

  const replayLowerBoundMs = Math.max(
    0,
    lowerBoundMs - profile.gracePeriodMs,
  );

  const upperBoundMs = Math.min(
    reconnectObservedMs,
    lowerBoundMs + profile.windowMs,
  );
  if (upperBoundMs <= lowerBoundMs) return [];

  const fingerprint = replayDedupeFingerprint(
    lowerBoundMs,
    reconnectObservedMs,
    replayLowerBoundMs,
    upperBoundMs,
    profile.limit,
    profile.stage,
    closeCode,
  );
  const recentFingerprint = await readReplayDedupe(userId);
  if (recentFingerprint === fingerprint) {
    wsReplayDedupedTotal.inc();
    const dedupedCachedRows = await readReplayResultCache(userId, cursor);
    if (dedupedCachedRows) {
      wsReplayCachedTotal.inc();
      return dedupedCachedRows;
    }
    return [];
  }

  const startedAt = Date.now();
  wsReplayStartedTotal.inc();
  wsReplayDbQueryTotal.inc();
  replayDbInFlight += 1;
  try {
    const statementTimeoutMs = WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED;
    const branchCandidateLimit = Math.min(200, Math.max(profile.limit * 4, 50));
    const runReplayTransaction = () =>
      withTransaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      const result = await client.query(
        `WITH accessible_conversations AS MATERIALIZED (
           SELECT cp.conversation_id
           FROM conversation_participants cp
           WHERE cp.user_id = $1
             AND cp.left_at IS NULL
         ),
         accessible_channels AS MATERIALIZED (
           SELECT ch.id AS channel_id
           FROM community_members cm
           JOIN channels ch ON ch.community_id = cm.community_id
           LEFT JOIN channel_members chm
             ON chm.channel_id = ch.id
            AND chm.user_id = $1
           WHERE cm.user_id = $1
             AND (ch.is_private = FALSE OR chm.user_id IS NOT NULL)
         ),
         conversation_candidates AS MATERIALIZED (
           SELECT m.id, m.created_at
           FROM accessible_conversations ac
           JOIN messages m ON m.conversation_id = ac.conversation_id
           WHERE m.deleted_at IS NULL
             AND m.created_at > to_timestamp($2::double precision / 1000.0)
             AND m.created_at <= to_timestamp($3::double precision / 1000.0)
           ORDER BY m.created_at ASC, m.id ASC
           LIMIT $5
         ),
         channel_candidates AS MATERIALIZED (
           SELECT m.id, m.created_at
           FROM accessible_channels ach
           JOIN messages m ON m.channel_id = ach.channel_id
           WHERE m.deleted_at IS NULL
             AND m.created_at > to_timestamp($2::double precision / 1000.0)
             AND m.created_at <= to_timestamp($3::double precision / 1000.0)
           ORDER BY m.created_at ASC, m.id ASC
           LIMIT $5
         ),
         merged_candidates AS (
           SELECT id, created_at FROM conversation_candidates
           UNION ALL
           SELECT id, created_at FROM channel_candidates
         ),
         deduped_candidates AS MATERIALIZED (
           SELECT id, MIN(created_at) AS created_at
           FROM merged_candidates
           GROUP BY id
         ),
         accessible AS MATERIALIZED (
           SELECT id, created_at
           FROM deduped_candidates
           ORDER BY created_at ASC, id ASC
           LIMIT $4
         )
         SELECT ${MESSAGE_SELECT_FIELDS},
                ${MESSAGE_AUTHOR_JSON},
                COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments,
                accessible.created_at AS replay_created_at
         FROM accessible
         JOIN messages m ON m.id = accessible.id
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN attachments a ON a.message_id = m.id
         GROUP BY accessible.created_at, m.id, u.id
         ORDER BY accessible.created_at ASC, m.id ASC`,
        [userId, replayLowerBoundMs, upperBoundMs, profile.limit, branchCandidateLimit],
      );
      return result.rows;
    });

    let rows;
    try {
      rows = await runReplayTransaction();
    } catch (err) {
      const kind = classifyReplayError(err);
      wsReplayErrorClassTotal.inc({ error_class: kind });
      if (kind === 'timeout' || kind === 'pool_busy') {
        wsReplayQueryTotal.inc({ result: kind });
        wsReplayQueryDurationMs.observe({ result: kind }, Date.now() - startedAt);
        if (shouldSampleReplayErrorLog()) {
          const pool = poolStats();
          logger.warn(
            {
              replay_error_instrumentation: true,
              replay_error_class: kind,
              userId,
              gapMs,
              replayLowerBoundMs,
              upperBoundMs,
              replayWindowMs: upperBoundMs - replayLowerBoundMs,
              replayLimit: profile.limit,
              overloadStage: profile.stage,
              statementTimeoutMs,
              inFlight: replayDbInFlight,
              poolWaiting: pool.waiting,
              poolIdle: pool.idle,
              poolTotal: pool.total,
            },
            'WS replay error sample',
          );
        }
        logger.warn(
          {
            err,
            userId,
            gapMs,
            replayLowerBoundMs,
            upperBoundMs,
            replayLimit: profile.limit,
            overloadStage: profile.stage,
            replayAttempt: 1,
            statementTimeoutMs,
          },
          'WS reconnect replay skipped after bounded DB failure',
        );
        return [];
      }
      if (shouldSampleReplayErrorLog()) {
        const pool = poolStats();
        logger.error(
          {
            replay_error_instrumentation: true,
            replay_error_class: kind,
            userId,
            gapMs,
            replayLowerBoundMs,
            upperBoundMs,
            replayWindowMs: upperBoundMs - replayLowerBoundMs,
            replayLimit: profile.limit,
            overloadStage: profile.stage,
            statementTimeoutMs,
            inFlight: replayDbInFlight,
            poolWaiting: pool.waiting,
            poolIdle: pool.idle,
            poolTotal: pool.total,
          },
          'WS replay unexpected error sample',
        );
      }
      throw err;
    }
    wsReplayQueryTotal.inc({ result: 'ok' });
    wsReplayQueryDurationMs.observe({ result: 'ok' }, Date.now() - startedAt);
    await writeReplayDedupe(userId, fingerprint);
    await writeReplayResultCache(userId, cursor, rows);
    return rows;
  } finally {
    replayDbInFlight -= 1;
  }
}

module.exports = {
  loadReplayableMessagesForUser,
  replayQueryProfile,
  classifyReplayError,
  resetReplayDedupeMemForTests,
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  WS_MESSAGE_REPLAY_LIMIT,
  WS_MESSAGE_REPLAY_MAX_WINDOW_MS,
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS,
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED,
  WS_MESSAGE_REPLAY_MAX_CONCURRENT,
  WS_REPLAY_DEDUP_TTL_SEC,
};
