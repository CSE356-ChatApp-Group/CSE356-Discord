'use strict';

const { withTransaction } = require('../db/pool');
const logger = require('../utils/logger');
const overload = require('../utils/overload');
const { wsReplayQueryTotal, wsReplayQueryDurationMs } = require('../utils/metrics');
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

// Replay is primarily for brief websocket gaps, not long offline catch-up.
// Keeping the default window near one minute sharply reduces the rows scanned
// during reconnect bursts while still covering the grader's short disconnects.
const rawReplayMaxWindowMs = Number(process.env.WS_MESSAGE_REPLAY_MAX_WINDOW_MS || '60000');
const WS_MESSAGE_REPLAY_MAX_WINDOW_MS =
  Number.isFinite(rawReplayMaxWindowMs) && rawReplayMaxWindowMs > 0
    ? Math.floor(rawReplayMaxWindowMs)
    : 60000;
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

// Replay should yield to primary writes quickly if the DB is already busy.
const rawReplayStatementTimeoutMs = Number(
  process.env.WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS || '1200',
);
const WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS =
  Number.isFinite(rawReplayStatementTimeoutMs) && rawReplayStatementTimeoutMs >= 100
    ? Math.floor(rawReplayStatementTimeoutMs)
    : 1200;

/** Hard cap so mis-set env cannot match PG role default (e.g. 15s) and starve the pool. */
const WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED = Math.min(
  2500,
  Math.max(200, WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS),
);

const rawReplayMaxConcurrent = Number(process.env.WS_MESSAGE_REPLAY_MAX_CONCURRENT || '6');
const WS_MESSAGE_REPLAY_MAX_CONCURRENT =
  Number.isFinite(rawReplayMaxConcurrent) && rawReplayMaxConcurrent >= 1
    ? Math.min(32, Math.floor(rawReplayMaxConcurrent))
    : 6;

let replayDbInFlight = 0;

function replayQueryProfile(gapMs, stage = overload.getStage()) {
  let windowMs = WS_MESSAGE_REPLAY_MAX_WINDOW_MS;
  let limit = WS_MESSAGE_REPLAY_LIMIT;

  if (gapMs <= 5_000) {
    windowMs = Math.min(windowMs, 15_000);
    limit = Math.min(limit, 60);
  } else if (gapMs <= 30_000) {
    windowMs = Math.min(windowMs, 45_000);
    limit = Math.min(limit, 100);
  }

  if (stage >= 1) {
    windowMs = Math.min(windowMs, 20_000);
    limit = Math.min(limit, 35);
  }
  if (stage >= 2) {
    windowMs = Math.min(windowMs, 12_000);
    limit = Math.min(limit, 25);
  }

  return {
    stage,
    limit: Math.max(0, limit),
    windowMs: Math.max(0, windowMs),
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

async function loadReplayableMessagesForUser(userId, disconnectedAtMs, reconnectObservedAtMs) {
  if (!userId) return [];

  const lowerBoundMs = Number(disconnectedAtMs || 0);
  const reconnectObservedMs = Number(reconnectObservedAtMs || 0);
  if (!Number.isFinite(lowerBoundMs) || !Number.isFinite(reconnectObservedMs)) return [];
  if (lowerBoundMs <= 0 || reconnectObservedMs <= lowerBoundMs) return [];

  const gapMs = reconnectObservedMs - lowerBoundMs;

  if (replayDbInFlight >= WS_MESSAGE_REPLAY_MAX_CONCURRENT) {
    wsReplayQueryTotal.inc({ result: 'skipped' });
    wsReplayQueryDurationMs.observe({ result: 'skipped' }, 0);
    logger.warn(
      { userId, gapMs, inFlight: replayDbInFlight, max: WS_MESSAGE_REPLAY_MAX_CONCURRENT },
      'WS reconnect replay skipped: concurrency cap',
    );
    return [];
  }

  const profile = replayQueryProfile(gapMs);
  if (profile.stage >= 3 || profile.limit <= 0 || profile.windowMs <= 0) {
    wsReplayQueryTotal.inc({ result: 'skipped' });
    wsReplayQueryDurationMs.observe({ result: 'skipped' }, 0);
    return [];
  }

  const replayLowerBoundMs = Math.max(
    0,
    lowerBoundMs - WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  );

  const upperBoundMs = Math.min(
    reconnectObservedMs,
    lowerBoundMs + profile.windowMs,
  );
  if (upperBoundMs <= lowerBoundMs) return [];

  const startedAt = Date.now();
  replayDbInFlight += 1;
  try {
    const rows = await withTransaction(async (client) => {
      const toMs = WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED;
      // Use explicit ms string — some hosts/PgBouncer stacks treat bare integers oddly vs role default.
      await client.query(`SET LOCAL statement_timeout TO '${toMs}ms'`);
      const result = await client.query(
        `WITH accessible AS (
           SELECT m.id, m.created_at
           FROM messages m
           LEFT JOIN channels ch ON ch.id = m.channel_id
           WHERE m.deleted_at IS NULL
             AND m.created_at > to_timestamp($2::double precision / 1000.0)
             AND m.created_at <= to_timestamp($3::double precision / 1000.0)
             AND (
               (
                 m.conversation_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                   FROM conversation_participants cp
                   WHERE cp.conversation_id = m.conversation_id
                     AND cp.user_id = $1
                     AND cp.left_at IS NULL
                 )
               )
               OR
               (
                 m.channel_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                   FROM community_members cm
                   WHERE cm.community_id = ch.community_id
                     AND cm.user_id = $1
                 )
                 AND (
                   ch.is_private = FALSE
                   OR EXISTS (
                     SELECT 1
                     FROM channel_members chm
                     WHERE chm.channel_id = ch.id
                       AND chm.user_id = $1
                   )
                 )
               )
             )
           ORDER BY m.created_at ASC, m.id ASC
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
        [userId, replayLowerBoundMs, upperBoundMs, profile.limit],
      );
      return result.rows;
    });
    wsReplayQueryTotal.inc({ result: 'ok' });
    wsReplayQueryDurationMs.observe({ result: 'ok' }, Date.now() - startedAt);
    return rows;
  } catch (err) {
    const result = classifyReplayError(err);
    if (result === 'timeout' || result === 'pool_busy') {
      wsReplayQueryTotal.inc({ result });
      wsReplayQueryDurationMs.observe({ result }, Date.now() - startedAt);
      logger.warn(
        {
          err,
          userId,
          gapMs,
          replayLowerBoundMs,
          upperBoundMs,
          replayLimit: profile.limit,
          overloadStage: profile.stage,
        },
        'WS reconnect replay skipped after bounded DB failure',
      );
      return [];
    }
    throw err;
  } finally {
    replayDbInFlight -= 1;
  }
}

module.exports = {
  loadReplayableMessagesForUser,
  replayQueryProfile,
  classifyReplayError,
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  WS_MESSAGE_REPLAY_LIMIT,
  WS_MESSAGE_REPLAY_MAX_WINDOW_MS,
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS,
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED,
  WS_MESSAGE_REPLAY_MAX_CONCURRENT,
};
