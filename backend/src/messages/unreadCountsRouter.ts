'use strict';

const express = require('express');
const { queryRead } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();
router.use(authenticate);

const UNREAD_COUNTS_QUERY_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.UNREAD_COUNTS_QUERY_TIMEOUT_MS || '750', 10);
  if (!Number.isFinite(raw) || raw < 100) return 750;
  return Math.min(5000, raw);
})();

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

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [channelResult, conversationResult] = await Promise.all([
      queryRead({
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
          LEFT JOIN LATERAL (
            SELECT last_read.created_at
            FROM messages last_read
            WHERE last_read.id = rs.last_read_message_id
          ) last_read ON TRUE
          LEFT JOIN messages m
            ON m.channel_id = rc.id
           AND m.deleted_at IS NULL
           AND m.author_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(rs.last_read_message_created_at, last_read.created_at, '-infinity'::timestamptz)
          GROUP BY rc.id`,
        values: [userId],
        query_timeout: UNREAD_COUNTS_QUERY_TIMEOUT_MS,
      }),
      queryRead({
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
          LEFT JOIN LATERAL (
            SELECT last_read.created_at
            FROM messages last_read
            WHERE last_read.id = rs.last_read_message_id
          ) last_read ON TRUE
          LEFT JOIN messages m
            ON m.conversation_id = c.id
           AND m.deleted_at IS NULL
           AND m.author_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(rs.last_read_message_created_at, last_read.created_at, '-infinity'::timestamptz)
          GROUP BY c.id`,
        values: [userId],
        query_timeout: UNREAD_COUNTS_QUERY_TIMEOUT_MS,
      }),
    ]);

    const unreadCounts = [
      ...channelResult.rows.map(normalizeCountRow),
      ...conversationResult.rows.map(normalizeCountRow),
    ];
    res.json({
      unreadCounts,
      counts: unreadCounts,
      data: unreadCounts,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
