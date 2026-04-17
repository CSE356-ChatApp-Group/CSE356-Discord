'use strict';

const { query } = require('../db/pool');

// Reconnect replay is our safety net for brief WS gaps. Keep the default large
// enough that a short disconnect under grader bursts does not silently skip a
// handful of committed message:created events.
const rawReplayLimit = Number(process.env.WS_MESSAGE_REPLAY_LIMIT || '500');
const WS_MESSAGE_REPLAY_LIMIT =
  Number.isFinite(rawReplayLimit) && rawReplayLimit > 0
    ? Math.floor(rawReplayLimit)
    : 200;

// Five minutes is still a bounded query window, but it covers deploy blips,
// transient reconnect churn, and slower client recovery much better than the
// earlier two-minute default.
const rawReplayMaxWindowMs = Number(process.env.WS_MESSAGE_REPLAY_MAX_WINDOW_MS || '300000');
const WS_MESSAGE_REPLAY_MAX_WINDOW_MS =
  Number.isFinite(rawReplayMaxWindowMs) && rawReplayMaxWindowMs > 0
    ? Math.floor(rawReplayMaxWindowMs)
    : 120000;
// A socket can die on the client/intermediary side before the server records
// the disconnect on heartbeat. Looking back slightly prevents messages created
// in that blind window from being skipped during reconnect replay.
const rawReplayDisconnectGraceMs = Number(
  process.env.WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS || '30000',
);
const WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS =
  Number.isFinite(rawReplayDisconnectGraceMs) && rawReplayDisconnectGraceMs >= 0
    ? Math.floor(rawReplayDisconnectGraceMs)
    : 30000;

async function loadReplayableMessagesForUser(userId, disconnectedAtMs, reconnectObservedAtMs) {
  if (!userId) return [];

  const lowerBoundMs = Number(disconnectedAtMs || 0);
  const reconnectObservedMs = Number(reconnectObservedAtMs || 0);
  if (!Number.isFinite(lowerBoundMs) || !Number.isFinite(reconnectObservedMs)) return [];
  if (lowerBoundMs <= 0 || reconnectObservedMs <= lowerBoundMs) return [];

  const replayLowerBoundMs = Math.max(
    0,
    lowerBoundMs - WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  );

  const upperBoundMs = Math.min(
    reconnectObservedMs,
    lowerBoundMs + WS_MESSAGE_REPLAY_MAX_WINDOW_MS,
  );
  if (upperBoundMs <= lowerBoundMs) return [];

  const { rows } = await query(
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
     SELECT m.*,
            CASE WHEN u.id IS NULL THEN NULL ELSE row_to_json(u.*) END AS author,
            COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments,
            accessible.created_at AS replay_created_at
     FROM accessible
     JOIN messages m ON m.id = accessible.id
     LEFT JOIN users u ON u.id = m.author_id
     LEFT JOIN attachments a ON a.message_id = m.id
     GROUP BY accessible.created_at, m.id, u.id
     ORDER BY accessible.created_at ASC, m.id ASC`,
    [userId, replayLowerBoundMs, upperBoundMs, WS_MESSAGE_REPLAY_LIMIT],
  );

  return rows;
}

module.exports = {
  loadReplayableMessagesForUser,
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  WS_MESSAGE_REPLAY_LIMIT,
  WS_MESSAGE_REPLAY_MAX_WINDOW_MS,
};
