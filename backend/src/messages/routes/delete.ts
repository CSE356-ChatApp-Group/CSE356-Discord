/**
 * DELETE /messages/:id
 *
 * Log prefix: `DELETE /messages:` for grep.
 */


const { param } = require("express-validator");
const { validate } = require("./validation");
const { query } = require("../../db/pool");
const overload = require("../../utils/overload");
const meiliClient = require("../../search/meiliClient");
const logger = require("../../utils/logger");
const sideEffects = require("../sideEffects");
const { bustMessagesCacheSafe } = require("../lib/messageListCache");
const { publishConversationEventNow } = require("../lib/conversationFanout");
const { messageFanoutEnvelope } = require("../realtimePayload");
const { publishChannelMessageEvent } = require("../channelRealtimeFanout");
const {
  repointChannelLastMessage,
  repointConversationLastMessage,
} = require("../repointLastMessage");
const { decrementChannelMessageCount } = require("../channelMessageCounter");

module.exports = function registerDeleteRoutes(router) {
  // --- DELETE /messages/:id: hard delete ---
  router.delete("/:id", param("id").isUUID(), async (req, res, next) => {
    if (!validate(req, res)) return;
    if (overload.shouldRestrictNonEssentialWrites()) {
      return res
        .status(503)
        .json({ error: "Deletes temporarily unavailable under high load" });
    }
    try {
      // Single CTE: check existence+authorship+access, collect attachment keys, delete — 1 round-trip vs 4.
      // The att CTE reads from the pre-DELETE snapshot so attachment rows are visible before CASCADE fires.
      const { rows } = await query(
        `WITH chk AS (
             SELECT
               (m.author_id = $2)                        AS is_author,
               CASE
                 WHEN m.channel_id IS NOT NULL THEN EXISTS (
                   SELECT 1 FROM channels c
                   JOIN communities co ON co.id = c.community_id
                   WHERE c.id = m.channel_id
                     AND (c.is_private = FALSE
                          OR co.owner_id = $2
                          OR EXISTS (
                            SELECT 1 FROM channel_members
                            WHERE channel_id = c.id AND user_id = $2
                          ))
                     AND (co.owner_id = $2
                          OR EXISTS (
                            SELECT 1 FROM community_members community_member
                            WHERE community_member.community_id = c.community_id
                              AND community_member.user_id = $2
                          ))
                 )
                 WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                   SELECT 1 FROM conversation_participants cp
                   WHERE cp.conversation_id = m.conversation_id
                     AND cp.user_id = $2 AND cp.left_at IS NULL
                 )
                 ELSE FALSE
               END                                       AS has_access
             FROM messages m
             WHERE m.id = $1 AND m.deleted_at IS NULL
           ),
           att AS (
             SELECT COALESCE(json_agg(a.storage_key), '[]'::json) AS keys
             FROM attachments a WHERE a.message_id = $1
           ),
           del AS (
             DELETE FROM messages
             WHERE id = $1 AND author_id = $2
               AND (SELECT COALESCE(is_author AND has_access, FALSE) FROM chk)
             RETURNING id, channel_id, conversation_id
           )
           SELECT
             (SELECT is_author  FROM chk) AS is_author,
             (SELECT has_access FROM chk) AS has_access,
             (SELECT keys FROM att)       AS attachment_keys,
             del.id, del.channel_id, del.conversation_id
           FROM   (VALUES (1)) dummy
           LEFT   JOIN del ON TRUE`,
        [req.params.id, req.user.id],
      );
      const row = rows[0];
      if (!row.is_author) {
        return res.status(404).json({ error: "Message not found or not yours" });
      }
      if (!row.has_access) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (!row.id) {
        return res.status(404).json({ error: "Message not found or not yours" });
      }
      const attachmentKeys: string[] = Array.isArray(row.attachment_keys)
        ? (row.attachment_keys as string[])
        : [];
      const message = {
        id: row.id,
        channel_id: row.channel_id,
        conversation_id: row.conversation_id,
      };
      sideEffects.deleteAttachmentObjects(attachmentKeys);
      // Keep the channel unread counter in sync: DECR mirrors the INCR done on create.
      if (message.channel_id) {
        repointChannelLastMessage(message.channel_id).catch((err) =>
          logger.warn(
            { err, channelId: message.channel_id },
            "repointChannelLastMessage failed",
          ),
        );
        decrementChannelMessageCount(message.channel_id).catch(() => {});
        await bustMessagesCacheSafe({ channelId: message.channel_id });
      }
      if (message.conversation_id) {
        repointConversationLastMessage(message.conversation_id).catch((err) =>
          logger.warn(
            { err, conversationId: message.conversation_id },
            "repointConversationLastMessage failed",
          ),
        );
        await bustMessagesCacheSafe({ conversationId: message.conversation_id });
      }
      if (message.conversation_id) {
        await publishConversationEventNow(
          message.conversation_id,
          "message:deleted",
          {
            id: message.id,
            conversation_id: message.conversation_id,
            conversationId: message.conversation_id,
          },
        );
      } else {
        await publishChannelMessageEvent(
          message.channel_id,
          messageFanoutEnvelope("message:deleted", {
            id: message.id,
            channel_id: message.channel_id,
            channelId: message.channel_id,
          }),
        );
      }

      res.json({ success: true });

      // Fire-and-forget: remove deleted message from Meilisearch.
      if (meiliClient.isEnabled() && message.id) {
        setImmediate(() => { meiliClient.deleteMessage(message.id).catch(() => {}); });
      }
    } catch (err) {
      next(err);
    }
  });
};

