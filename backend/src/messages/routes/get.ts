/**
 * GET /messages and GET /messages/context/:messageId
 *
 * Sections: `GET /messages:` history + cache; `GET /messages/context:` anchor window.
 */


const { query, queryRead } = require("../../db/pool");
const {
  messagesListQuery,
  channelMessagesListQueryWithPrimaryRetry,
} = require("./getReadRouting");
const {
  query: qv,
  param,
} = require("express-validator");
const { validate } = require("./validation");
const {
  messagesListAccessCacheHitTotal,
  messageListCacheStoreSkippedTotal,
} = require("../../utils/metrics");
const overload = require("../../utils/overload");
const redis = require("../../db/redis");
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require("../../utils/distributedSingleflight");
const {
  recordEndpointListCache,
  recordEndpointListCacheBypass,
} = require("../../utils/endpointCacheMetrics");
const {
  checkChannelAccessForUser,
  ensureActiveConversationParticipant,
} = require("../lib/accessChecks");
const {
  MESSAGES_CACHE_TTL_SECS,
  msgInflight,
  convMsgInflight,
} = require("../lib/messageListCache");
const {
  channelMsgCacheKey,
  conversationMsgCacheKey,
  channelMsgCacheEpochKey,
  conversationMsgCacheEpochKey,
  readMessageCacheEpoch,
} = require("../messageCacheBust");
const {
  channelIdIfOnlyConversationQueryParam,
  loadMessageTargetForUser,
} = require("../accessCaches");
const {
  setChannelAccessCache,
  checkChannelAccessCache,
  raceChannelAccess,
} = require("../channelAccessCache");
const {
  MESSAGE_SELECT_FIELDS,
  MESSAGE_AUTHOR_JSON,
} = require("../sqlFragments");

const DEFAULT_CONTEXT_SIDE_LIMIT = 25;

module.exports = function registerGetRoutes(router) {
  // --- GET /messages: history (cache + pagination) ---
  router.get(
    "/",
    qv("channelId").optional().isUUID(),
    qv("conversationId").optional().isUUID(),
    qv("before").optional().isUUID(), // cursor-based pagination
    qv("after").optional().isUUID(), // forward pagination from an anchor
    qv("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    async (req, res, next) => {
      if (!validate(req, res)) return;
    try {
      let channelId = req.query.channelId;
      let conversationId = req.query.conversationId;
      const { before, after } = req.query;
      const requestedLimit = Number(req.query.limit || 50);
      const limit = overload.historyLimit(requestedLimit);

      if (!channelId && !conversationId) {
        return res
          .status(400)
          .json({ error: "channelId or conversationId required" });
      }
      if (before && after) {
        return res
          .status(400)
          .json({ error: "before and after cannot be used together" });
      }

      if (!channelId && conversationId) {
        const asChannel = await channelIdIfOnlyConversationQueryParam(
          conversationId,
          req.user.id,
        );
        if (asChannel) {
          channelId = asChannel;
          conversationId = undefined;
        }
      }

      // Serve the most-recent page of a public/member channel from a short-lived
      // Redis cache.  All users in a channel see the same messages, so a single
      // shared key is correct. Pagination (before=) bypasses this cache. POST busts
      // the key so the latest page stays consistent with new writes; TTL remains
      // a backstop for edits/deletes from other paths.
      if (channelId && !before && !after) {
        const ensureChannelHistoryAccess = async () => {
          const hasAccess = await raceChannelAccess(
            redis,
            channelId,
            req.user.id,
            () => checkChannelAccessForUser(channelId, req.user.id),
          );
          if (hasAccess) setChannelAccessCache(redis, channelId, req.user.id);
          return hasAccess;
        };
        const requireChannelHistoryAccess = async () => {
          if (await ensureChannelHistoryAccess()) return;
          const err: any = new Error("Access denied");
          err.statusCode = 403;
          throw err;
        };
        const epochKey = channelMsgCacheEpochKey(channelId);
        const epochBefore = await readMessageCacheEpoch(redis, epochKey);
        const cacheKey = channelMsgCacheKey(channelId, {
          limit,
          epoch: epochBefore,
        });
        const cached = await getJsonCache(redis, cacheKey);
        if (cached) {
          if (!(await ensureChannelHistoryAccess())) {
            return res.status(403).json({ error: "Access denied" });
          }
          recordEndpointListCache("messages_channel", "hit");
          return res.json(cached);
        }

        // Singleflight: if a DB query for this channel is already in-flight,
        // wait for it rather than spawning a duplicate concurrent query.
        if (msgInflight.has(cacheKey)) {
          recordEndpointListCache("messages_channel", "coalesced");
          try {
            await requireChannelHistoryAccess();
            return res.json(await msgInflight.get(cacheKey));
          } catch (err) {
            if ((err as any)?.statusCode === 403)
              return res.status(403).json({ error: (err as any).message });
            return next(err);
          }
        }

        recordEndpointListCache("messages_channel", "miss");
        const promise: Promise<{ messages: any[] }> =
          withDistributedSingleflight({
            redis,
            cacheKey,
            inflight: msgInflight,
            readFresh: async () => getJsonCache(redis, cacheKey),
            readStale: async () => getJsonCache(redis, staleCacheKey(cacheKey)),
            beforeReturnShared: requireChannelHistoryAccess,
            load: async () => {
              let accessWhere = `EXISTS (
                SELECT 1
                FROM channels c
                JOIN communities co ON co.id = c.community_id
                WHERE c.id = $3
                  AND (
                    c.is_private = FALSE
                    OR co.owner_id = $2
                    OR EXISTS (
                      SELECT 1
                      FROM channel_members cm
                      WHERE cm.channel_id = c.id
                        AND cm.user_id = $2
                    )
                  )
                  AND (
                    co.owner_id = $2
                    OR EXISTS (
                      SELECT 1
                      FROM community_members community_member
                      WHERE community_member.community_id = c.community_id
                        AND community_member.user_id = $2
                    )
                  )
              )`;
              try {
                if (await checkChannelAccessCache(redis, channelId, req.user.id)) {
                  messagesListAccessCacheHitTotal.inc({ path: "channel_latest" });
                  accessWhere = "$2::uuid IS NOT NULL";
                }
              } catch {
                /* fail open */
              }

              const { rows } = await channelMessagesListQueryWithPrimaryRetry(
                req,
                `
              WITH access AS (
                SELECT ${accessWhere} AS has_access
              )
              SELECT access.has_access,
                     msg.*
              FROM access
              LEFT JOIN LATERAL (
                SELECT ${MESSAGE_SELECT_FIELDS},
                       ${MESSAGE_AUTHOR_JSON},
                       COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
                FROM messages m
                LEFT JOIN users u ON u.id = m.author_id
                LEFT JOIN attachments a ON a.message_id = m.id
                WHERE m.channel_id = $3
                  AND m.deleted_at IS NULL
                GROUP BY m.id, u.id
                ORDER BY m.created_at DESC
                LIMIT $1
              ) AS msg ON access.has_access = TRUE
            `,
                [limit, req.user.id, channelId],
              );
              if (!rows[0]?.has_access) {
                const err: any = new Error("Access denied");
                err.statusCode = 403;
                throw err;
              }
              setChannelAccessCache(redis, channelId, req.user.id);
              const messages: any[] = [];
              for (let i = rows.length - 1; i >= 0; i -= 1) {
                const row = rows[i];
                if (row && row.id) messages.push(row);
              }
              const body = { messages };
              const epochAfter = await readMessageCacheEpoch(redis, epochKey);
              if (epochBefore === epochAfter) {
                await setJsonCacheWithStale(
                  redis,
                  cacheKey,
                  body,
                  MESSAGES_CACHE_TTL_SECS,
                  { writeStale: false },
                );
              } else {
                messageListCacheStoreSkippedTotal.inc({
                  scope: "channel",
                  reason: "epoch_changed",
                });
              }
              return body;
            },
          });

        try {
          return res.json(await promise);
        } catch (err: any) {
          if (err.statusCode === 403)
            return res.status(403).json({ error: err.message });
          return next(err);
        }
      }
      if (channelId && (before || after)) {
        recordEndpointListCacheBypass("messages_channel", "pagination");
      }

      // Conversation messages (non-paginated) — same singleflight+cache pattern as channels.
      // All participants see identical message history so the cache is shared by conversationId.
      // POST busts this key; WS still carries realtime delivery.
      if (conversationId && !before && !after) {
        const ensureConversationHistoryAccess = async () =>
          ensureActiveConversationParticipant(conversationId, req.user.id);
        const requireConversationHistoryAccess = async () => {
          if (await ensureConversationHistoryAccess()) return;
          const err: any = new Error("Not a participant");
          err.statusCode = 403;
          throw err;
        };
        const epochKey = conversationMsgCacheEpochKey(conversationId);
        const epochBefore = await readMessageCacheEpoch(redis, epochKey);
        const cacheKey = conversationMsgCacheKey(conversationId, {
          limit,
          epoch: epochBefore,
        });
        const cached = await getJsonCache(redis, cacheKey);
        if (cached) {
          if (!(await ensureConversationHistoryAccess())) {
            return res.status(403).json({ error: "Not a participant" });
          }
          recordEndpointListCache("messages_conversation", "hit");
          return res.json(cached);
        }

        if (convMsgInflight.has(cacheKey)) {
          recordEndpointListCache("messages_conversation", "coalesced");
          try {
            await requireConversationHistoryAccess();
            return res.json(await convMsgInflight.get(cacheKey));
          } catch (err) {
            if ((err as any)?.statusCode === 403)
              return res.status(403).json({ error: (err as any).message });
            return next(err);
          }
        }

        recordEndpointListCache("messages_conversation", "miss");
        const promise: Promise<{ messages: any[] }> =
          withDistributedSingleflight({
            redis,
            cacheKey,
            inflight: convMsgInflight,
            readFresh: async () => getJsonCache(redis, cacheKey),
            readStale: async () => getJsonCache(redis, staleCacheKey(cacheKey)),
            beforeReturnShared: requireConversationHistoryAccess,
            load: async () => {
              const { rows } = await messagesListQuery(
                req,
                `
            WITH access AS (
              SELECT EXISTS (
                SELECT 1 FROM conversation_participants cp
                WHERE cp.conversation_id = $3 AND cp.user_id = $2 AND cp.left_at IS NULL
              ) AS has_access
            )
            SELECT access.has_access,
                   msg.*
            FROM access
            LEFT JOIN LATERAL (
              SELECT ${MESSAGE_SELECT_FIELDS},
                     ${MESSAGE_AUTHOR_JSON},
                     COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
              FROM messages m
              LEFT JOIN users u ON u.id = m.author_id
              LEFT JOIN attachments a ON a.message_id = m.id
              WHERE m.conversation_id = $3
                AND m.deleted_at IS NULL
              GROUP BY m.id, u.id
              ORDER BY m.created_at DESC
              LIMIT $1
            ) AS msg ON access.has_access = TRUE
            `,
                [limit, req.user.id, conversationId],
              );
              if (!rows[0]?.has_access) {
                const err: any = new Error("Not a participant");
                err.statusCode = 403;
                throw err;
              }
              const messages: any[] = [];
              for (let i = rows.length - 1; i >= 0; i -= 1) {
                const row = rows[i];
                if (row && row.id) messages.push(row);
              }
              const body = { messages };
              const epochAfter = await readMessageCacheEpoch(redis, epochKey);
              if (epochBefore === epochAfter) {
                await setJsonCacheWithStale(
                  redis,
                  cacheKey,
                  body,
                  MESSAGES_CACHE_TTL_SECS,
                  { writeStale: false },
                );
              } else {
                messageListCacheStoreSkippedTotal.inc({
                  scope: "conversation",
                  reason: "epoch_changed",
                });
              }
              return body;
            },
          });

        try {
          return res.json(await promise);
        } catch (err: any) {
          if (err.statusCode === 403)
            return res.status(403).json({ error: err.message });
          return next(err);
        }
      }
      if (conversationId && (before || after)) {
        recordEndpointListCacheBypass("messages_conversation", "pagination");
      }

      // Paginated requests (before= cursor) — no caching.
      // Build a single query that enforces access control and returns messages in one pool checkout.
      const params: any[] = [limit, req.user.id];

      let accessWhere: string | null = null;
      let targetWhere: string;

      if (channelId) {
        params.push(channelId);
        const ci = params.length; // $3

        try {
          if (await checkChannelAccessCache(redis, channelId, req.user.id)) {
            messagesListAccessCacheHitTotal.inc({ path: "channel_paginated" });
            accessWhere = "$2::uuid IS NOT NULL";
          }
        } catch {
          /* fail open */
        }

        if (!accessWhere) {
          accessWhere = `EXISTS (
            SELECT 1 FROM channels c
            JOIN communities co ON co.id = c.community_id
            WHERE c.id = $${ci}
              AND (c.is_private = FALSE
                   OR co.owner_id = $2
                   OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
              AND (co.owner_id = $2
                   OR EXISTS (
                     SELECT 1 FROM community_members community_member
                     WHERE community_member.community_id = c.community_id
                       AND community_member.user_id = $2
                   ))
          )`;
        }
        targetWhere = `m.channel_id = $${ci}`;
      } else {
        params.push(conversationId);
        const ci = params.length; // $3
        accessWhere = `EXISTS (
          SELECT 1 FROM conversation_participants cp
          WHERE cp.conversation_id = $${ci} AND cp.user_id = $2 AND cp.left_at IS NULL
        )`;
        targetWhere = `m.conversation_id = $${ci}`;
      }

      if (before) {
        params.push(before);
        targetWhere += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
      }

      const orderDirection = after ? "ASC" : "DESC";
      if (after) {
        params.push(after);
        targetWhere += ` AND m.created_at > (SELECT created_at FROM messages WHERE id = $${params.length})`;
      }

      const sql = `
        WITH access AS (
          SELECT ${accessWhere} AS has_access
        )
        SELECT access.has_access,
               msg.*
        FROM access
        LEFT JOIN LATERAL (
          SELECT ${MESSAGE_SELECT_FIELDS},
                 ${MESSAGE_AUTHOR_JSON},
                 COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
          FROM   messages m
          LEFT JOIN users u ON u.id = m.author_id
          LEFT JOIN attachments a ON a.message_id = m.id
          WHERE  ${targetWhere}
            AND  m.deleted_at IS NULL
          GROUP  BY m.id, u.id
          ORDER  BY m.created_at ${orderDirection}
          LIMIT  $1
        ) AS msg ON access.has_access = TRUE
      `;

      const { rows } = channelId
        ? await channelMessagesListQueryWithPrimaryRetry(req, sql, params)
        : await messagesListQuery(req, sql, params);

      if (!rows[0]?.has_access) {
        return res
          .status(403)
          .json({ error: channelId ? "Access denied" : "Not a participant" });
      }

      if (channelId) setChannelAccessCache(redis, channelId, req.user.id);

      const messageRows = rows.filter((row) => row.id);
      const orderedRows = after ? messageRows : messageRows.reverse();
      const body = { messages: orderedRows };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
  );

  // --- GET /messages/context/:messageId: anchor window ---
  router.get(
    "/context/:messageId",
    param("messageId").isUUID(),
    qv("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
    async (req, res, next) => {
      if (!validate(req, res)) return;
    try {
      const messageId = req.params.messageId;
      const requestedLimit = Number(
        req.query.limit || DEFAULT_CONTEXT_SIDE_LIMIT,
      );
      const sideLimit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 50)
        : DEFAULT_CONTEXT_SIDE_LIMIT;

      const target = await loadMessageTargetForUser(messageId, req.user.id);
      if (!target) {
        return res.status(404).json({ error: "Message not found" });
      }

      if (!target.has_access) {
        return res.status(403).json({ error: "Access denied" });
      }

      const scope = target.channel_id
        ? "m.channel_id = t.channel_id"
        : "m.conversation_id = t.conversation_id";

      const { rows } = await queryRead(
        `WITH target AS (
           SELECT id, channel_id, conversation_id, created_at
           FROM messages
           WHERE id = $1 AND deleted_at IS NULL
         ),
         before_ids AS (
           SELECT m.id, m.created_at
           FROM messages m
           JOIN target t ON ${scope}
           WHERE m.deleted_at IS NULL
             AND (
               m.created_at < t.created_at
               OR (m.created_at = t.created_at AND m.id < t.id)
             )
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $2
         ),
         after_ids AS (
           SELECT m.id, m.created_at
           FROM messages m
           JOIN target t ON ${scope}
           WHERE m.deleted_at IS NULL
             AND (
               m.created_at > t.created_at
               OR (m.created_at = t.created_at AND m.id > t.id)
             )
           ORDER BY m.created_at ASC, m.id ASC
           LIMIT $2
         ),
         context_ids AS (
           SELECT id, created_at FROM before_ids
           UNION ALL
           SELECT id, created_at FROM target
           UNION ALL
           SELECT id, created_at FROM after_ids
         )
         SELECT ${MESSAGE_SELECT_FIELDS},
                ${MESSAGE_AUTHOR_JSON},
                COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments,
                (SELECT COUNT(*) FROM before_ids)::int AS before_count,
                (SELECT COUNT(*) FROM after_ids)::int AS after_count
         FROM context_ids ctx
         JOIN messages m ON m.id = ctx.id
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN attachments a ON a.message_id = m.id
         GROUP BY ctx.created_at, m.id, u.id
         ORDER BY ctx.created_at ASC, m.id ASC`,
        [messageId, sideLimit],
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Message not found" });
      }

      const beforeCount = Number(rows[0].before_count || 0);
      const afterCount = Number(rows[0].after_count || 0);
      const messages = rows.map(
        ({ before_count, after_count, ...message }) => message,
      );

      res.json({
        targetMessageId: target.id,
        channelId: target.channel_id,
        conversationId: target.conversation_id,
        hasOlder: beforeCount === sideLimit,
        hasNewer: afterCount === sideLimit,
        messages,
      });
    } catch (err) {
      next(err);
    }
  },
  );
};
