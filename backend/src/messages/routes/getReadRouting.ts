/**
 * Primary vs read-replica routing for GET /messages list queries.
 */

const {
  query,
  queryRead,
  readPool,
} = require("../../db/pool");

/**
 * When `PG_READ_REPLICA_URL` is set, list queries default to the replica (eventual consistency).
 * Send `X-ChatApp-Read-Consistency: primary` (or `strong`) to force the primary for read-your-writes
 * after a POST (grading / UX). Direct-message history defaults to the primary because
 * both participants expect immediate visibility after conversation creation/invite/send.
 */
function wantsMessagesListPrimary(req: any) {
  if (!readPool) return false;
  const v = (req.get("x-chatapp-read-consistency") || "").trim().toLowerCase();
  if (v === "primary" || v === "strong") return true;
  return Boolean(req?.query?.conversationId);
}

async function messagesListQuery(req: any, sql: string, params: unknown[]) {
  if (wantsMessagesListPrimary(req)) {
    return query(sql, params);
  }
  return queryRead(sql, params);
}

/**
 * Replica-first channel list reads can transiently return has_access=false right
 * after create/join due to replica lag on community_members/channel_members.
 * Retry once on primary before returning 403 so we preserve correctness while
 * keeping the steady-state read load on replicas.
 */
async function channelMessagesListQueryWithPrimaryRetry(req: any, sql: string, params: unknown[]) {
  if (wantsMessagesListPrimary(req)) {
    return query(sql, params);
  }

  const replicaResult = await queryRead(sql, params);
  if (replicaResult?.rows?.[0]?.has_access) {
    return replicaResult;
  }

  return query(sql, params);
}

module.exports = {
  wantsMessagesListPrimary,
  messagesListQuery,
  channelMessagesListQueryWithPrimaryRetry,
};
