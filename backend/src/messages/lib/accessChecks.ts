/**
 * Channel / conversation / message access checks for the messages router (primary DB).
 */

"use strict";

const { query } = require("../../db/pool");

async function checkChannelAccessForUser(
  channelId: string,
  userId: string,
): Promise<boolean> {
  try {
    // Use primary: replica lag caused false "no access" right after create/join (GET /messages 403).
    const { rows } = await query(
      `SELECT EXISTS (
         SELECT 1 FROM channels c
         JOIN communities co ON co.id = c.community_id
         WHERE c.id = $1
           AND (c.is_private = FALSE
                OR co.owner_id = $2
                OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
           AND (co.owner_id = $2
                OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2))
       ) AS has_access`,
      [channelId, userId],
    );
    return rows[0]?.has_access === true;
  } catch {
    return false;
  }
}

async function ensureActiveConversationParticipant(conversationId: string, userId: string) {
  const { rows } = await query(
    `SELECT 1
     FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

async function ensureChannelAccess(channelId: string, userId: string) {
  const { rows } = await query(
    `SELECT 1
     FROM channels c
     JOIN communities co ON co.id = c.community_id
     WHERE c.id = $1
       AND (c.is_private = FALSE
            OR co.owner_id = $2
            OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
       AND (co.owner_id = $2
            OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2))`,
    [channelId, userId],
  );
  return rows.length > 0;
}

async function ensureMessageAccess(target: any, userId: string) {
  const channelId = target?.channelId ?? target?.channel_id ?? null;
  const conversationId =
    target?.conversationId ?? target?.conversation_id ?? null;
  if (conversationId)
    return ensureActiveConversationParticipant(conversationId, userId);
  if (channelId) return ensureChannelAccess(channelId, userId);
  return false;
}

module.exports = {
  checkChannelAccessForUser,
  ensureActiveConversationParticipant,
  ensureChannelAccess,
  ensureMessageAccess,
};
