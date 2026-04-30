
const express = require('express');
const { queryRead, poolStats } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const logger = require('../utils/logger');
const {
  unreadCountsShedTotal,
  unreadCountsCoalescedTotal,
} = require('../utils/metrics');

const router = express.Router();
router.use(authenticate);

const UNREAD_COUNTS_QUERY_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.UNREAD_COUNTS_QUERY_TIMEOUT_MS || '750', 10);
  if (!Number.isFinite(raw) || raw < 100) return 750;
  return Math.min(5000, raw);
})();

const UNREAD_COUNTS_MAX_INFLIGHT = (() => {
  const raw = Number.parseInt(process.env.UNREAD_COUNTS_MAX_INFLIGHT || '48', 10);
  if (!Number.isFinite(raw) || raw < 1) return 48;
  return Math.min(1000, raw);
})();

const UNREAD_COUNTS_DEFER_POOL_WAITING = (() => {
  const raw = Number.parseInt(process.env.UNREAD_COUNTS_DEFER_POOL_WAITING || '8', 10);
  if (!Number.isFinite(raw) || raw < 0) return 8;
  return Math.min(1000, raw);
})();

let unreadCountsInFlight = 0;
const unreadCountsByUserInFlight = new Map();

function normalizeCountRow(row) {
  const type = row.type === 'conversation' ? 'conversation' : 'channel';
  const id = String(row.conversation_id || row.channel_id || '');
  return {
    conversationId: id,
    conversation_id: id,
    channelId: row.channel_id ? String(row.channel_id) : undefined,
    channel_id: row.channel_id ? String(row.channel_id) : undefined,
    type,
    count: Math.max(0, Number(row.count || 0)),
  };
}

function isUnreadCountsTimeout(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    err?.code === '57014' ||
    msg.includes('statement timeout') ||
    msg.includes('query read timeout') ||
    msg.includes('query timed out')
  );
}

async function safeUnreadCountsQuery(scope, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isUnreadCountsTimeout(err)) {
      logger.warn(
        { err, scope },
        'Unread-counts query timed out; using empty fallback to avoid 500',
      );
      return { rows: [] };
    }
    throw err;
  }
}

function emptyUnreadCountsPayload() {
  return { unreadCounts: [], counts: [], data: [] };
}

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const inFlightForUser = unreadCountsByUserInFlight.get(userId);
    if (inFlightForUser) {
      unreadCountsCoalescedTotal.inc();
      const cachedPayload = await inFlightForUser;
      return res.json(cachedPayload);
    }

    const pool = poolStats();
    if (
      UNREAD_COUNTS_DEFER_POOL_WAITING > 0 &&
      Number.isFinite(pool?.waiting) &&
      pool.waiting >= UNREAD_COUNTS_DEFER_POOL_WAITING
    ) {
      unreadCountsShedTotal.inc({ reason: 'pool_waiting' });
      logger.warn(
        { waiting: pool.waiting, threshold: UNREAD_COUNTS_DEFER_POOL_WAITING },
        'Unread-counts query shed due to pg pool waiting pressure; using empty fallback',
      );
      return res.json(emptyUnreadCountsPayload());
    }

    if (unreadCountsInFlight >= UNREAD_COUNTS_MAX_INFLIGHT) {
      unreadCountsShedTotal.inc({ reason: 'inflight_cap' });
      logger.warn(
        { inFlight: unreadCountsInFlight, maxInFlight: UNREAD_COUNTS_MAX_INFLIGHT },
        'Unread-counts query shed due to inflight pressure; using empty fallback',
      );
      return res.json(emptyUnreadCountsPayload());
    }

    const loadPromise = (async () => {
      unreadCountsInFlight += 1;
      let channelResult;
      let conversationResult;
      try {
        // Run sequentially to avoid doubling per-request DB pressure on the read pool.
        channelResult = await safeUnreadCountsQuery('channel', () => queryRead({
          text: `
          WITH readable_channels AS (
            SELECT ch.id
            FROM channels ch
            JOIN communities co ON co.id = ch.community_id
            LEFT JOIN community_members cm
              ON cm.community_id = ch.community_id
             AND cm.user_id = $1
            LEFT JOIN channel_members chm
              ON chm.channel_id = ch.id
             AND chm.user_id = $1
            WHERE (cm.user_id IS NOT NULL OR co.owner_id = $1)
              AND (ch.is_private = FALSE OR chm.user_id IS NOT NULL OR co.owner_id = $1)
          )
          SELECT
            'channel'::text AS type,
            rc.id::text AS channel_id,
            rc.id::text AS conversation_id,
            COUNT(m.id)::int AS count
          FROM readable_channels rc
          LEFT JOIN read_states rs
            ON rs.channel_id = rc.id
           AND rs.user_id = $1
          LEFT JOIN messages last_read
            ON rs.last_read_message_created_at IS NULL
           AND last_read.id = rs.last_read_message_id
          LEFT JOIN messages m
            ON m.channel_id = rc.id
           AND m.deleted_at IS NULL
           AND m.author_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(
             rs.last_read_message_created_at,
             last_read.created_at,
             '-infinity'::timestamptz
           )
          GROUP BY rc.id`,
          values: [userId],
          query_timeout: UNREAD_COUNTS_QUERY_TIMEOUT_MS,
        }));
        conversationResult = await safeUnreadCountsQuery('conversation', () => queryRead({
          text: `
          SELECT
            'conversation'::text AS type,
            NULL::text AS channel_id,
            c.id::text AS conversation_id,
            COUNT(m.id)::int AS count
          FROM conversations c
          JOIN conversation_participants cp
            ON cp.conversation_id = c.id
           AND cp.user_id = $1
           AND cp.left_at IS NULL
          LEFT JOIN read_states rs
            ON rs.conversation_id = c.id
           AND rs.user_id = $1
          LEFT JOIN messages last_read
            ON rs.last_read_message_created_at IS NULL
           AND last_read.id = rs.last_read_message_id
          LEFT JOIN messages m
            ON m.conversation_id = c.id
           AND m.deleted_at IS NULL
           AND m.author_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(
             rs.last_read_message_created_at,
             last_read.created_at,
             '-infinity'::timestamptz
           )
          GROUP BY c.id`,
          values: [userId],
          query_timeout: UNREAD_COUNTS_QUERY_TIMEOUT_MS,
        }));
      } finally {
        unreadCountsInFlight = Math.max(0, unreadCountsInFlight - 1);
      }

      const unreadCounts = [
        ...channelResult.rows.map(normalizeCountRow),
        ...conversationResult.rows.map(normalizeCountRow),
      ];
      return { unreadCounts, counts: unreadCounts, data: unreadCounts };
    })();
    unreadCountsByUserInFlight.set(userId, loadPromise);
    try {
      const payload = await loadPromise;
      return res.json(payload);
    } finally {
      unreadCountsByUserInFlight.delete(userId);
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
