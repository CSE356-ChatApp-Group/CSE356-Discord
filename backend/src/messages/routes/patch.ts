/**
 * PATCH /messages/:id
 *
 * Log prefix: `PATCH /messages:` for grep.
 */


const { param, body } = require("express-validator");
const { validate } = require("./validation");
const { query } = require("../../db/pool");
const overload = require("../../utils/overload");
const meiliClient = require("../../search/meiliClient");
const { bustMessagesCacheSafe } = require("../lib/messageListCache");
const { publishConversationEventNow } = require("../lib/conversationFanout");
const { messageFanoutEnvelope } = require("../realtimePayload");
const { publishChannelMessageEvent } = require("../channelRealtimeFanout");
const {
  MESSAGE_RETURNING_FIELDS,
  MESSAGE_AUTHOR_JSON,
} = require("../sqlFragments");

module.exports = function registerPatchRoutes(router) {
  // --- PATCH /messages/:id: edit content ---
  router.patch(
    "/:id",
    param("id").isUUID(),
    body("content").isString(),
    async (req, res, next) => {
      if (!validate(req, res)) return;
      if (overload.shouldRestrictNonEssentialWrites()) {
        return res
          .status(503)
          .json({ error: "Edits temporarily unavailable under high load" });
      }
      try {
      // Single CTE: check existence+authorship+access, update, join author — 1 round-trip vs 4.
      const { rows } = await query(
        `WITH chk AS (
           SELECT
             (m.author_id = $3)                        AS is_author,
             CASE
               WHEN m.channel_id IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM channels c
                 JOIN communities co ON co.id = c.community_id
                 WHERE c.id = m.channel_id
                   AND (c.is_private = FALSE
                        OR co.owner_id = $3
                        OR EXISTS (
                          SELECT 1 FROM channel_members
                          WHERE channel_id = c.id AND user_id = $3
                        ))
                   AND (co.owner_id = $3
                        OR EXISTS (
                          SELECT 1 FROM community_members community_member
                          WHERE community_member.community_id = c.community_id
                            AND community_member.user_id = $3
                        ))
               )
               WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM conversation_participants cp
                 WHERE cp.conversation_id = m.conversation_id
                   AND cp.user_id = $3 AND cp.left_at IS NULL
               )
               ELSE FALSE
             END                                       AS has_access
           FROM messages m
           WHERE m.id = $2 AND m.deleted_at IS NULL
         ),
         upd AS (
           UPDATE messages
           SET content = $1, edited_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND author_id = $3 AND deleted_at IS NULL
             AND (SELECT COALESCE(is_author AND has_access, FALSE) FROM chk)
           RETURNING ${MESSAGE_RETURNING_FIELDS}
         )
         SELECT
           (SELECT is_author  FROM chk) AS is_author,
           (SELECT has_access FROM chk) AS has_access,
           upd.*,
           ${MESSAGE_AUTHOR_JSON},
           '[]'::json                  AS attachments
         FROM   (VALUES (1)) dummy
         LEFT   JOIN upd ON TRUE
         LEFT   JOIN users u ON u.id = upd.author_id`,
        [req.body.content, req.params.id, req.user.id],
      );
      const row = rows[0];
      if (!row.is_author) {
        return res
          .status(404)
          .json({ error: "Message not found or not yours" });
      }
      if (!row.has_access) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (!row.id) {
        return res
          .status(404)
          .json({ error: "Message not found or not yours" });
      }
      const { is_author, has_access, ...message } = row;
      // Bust the Redis message cache so a GET immediately after returns updated content.
      if (message.channel_id) {
        await bustMessagesCacheSafe({ channelId: message.channel_id });
      }
      if (message.conversation_id) {
        await bustMessagesCacheSafe({
          conversationId: message.conversation_id,
        });
        await publishConversationEventNow(
          message.conversation_id,
          "message:updated",
          message,
        );
      } else {
        await publishChannelMessageEvent(
          message.channel_id,
          messageFanoutEnvelope("message:updated", message),
        );
      }
      res.json({ message });

      // Fire-and-forget: update Meilisearch with edited content.
      // communityId requires a channel lookup since it's not in MESSAGE_RETURNING_FIELDS.
      if (meiliClient.isEnabled() && message.id) {
        setImmediate(() => {
          (async () => {
            let communityId: string | null = null;
            if (message.channel_id) {
              try {
                const { rows: chRows } = await query(
                  "SELECT community_id FROM channels WHERE id = $1",
                  [message.channel_id],
                );
                communityId = chRows[0]?.community_id || null;
              } catch { /* non-fatal */ }
            }
            await meiliClient.indexMessage({
              id: message.id,
              content: message.content || "",
              authorId: message.author_id,
              channelId: message.channel_id || null,
              communityId,
              conversationId: message.conversation_id || null,
              createdAt: new Date(message.created_at).getTime(),
              updatedAt: new Date(message.updated_at || Date.now()).getTime(),
            });
          })().catch(() => {});
        });
      }
    } catch (err) {
      next(err);
    }
    },
  );
};

