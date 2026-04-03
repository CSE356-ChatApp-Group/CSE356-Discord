/**
 * Presence service
 *
 * Presence is stored in Redis (TTL-based) as the source of truth for
 * real-time status, with a periodic mirror into Postgres for analytics/history.
 *
 * Redis key:  presence:<userId>   value: 'online' | 'idle' | 'away' | 'offline'
 * TTL:        90 seconds (refreshed by heartbeats from the WS server)
 *
 * When a key expires, the user is effectively 'offline'.
 */

"use strict";

const redis = require("../db/redis");
const fanout = require("../websocket/fanout");
const { pool } = require("../db/pool");
const overload = require("../utils/overload");
const logger = require("../utils/logger");
const { presenceFanoutTotal } = require("../utils/metrics");
const { tracer } = require("../utils/tracer");

const TTL_SECONDS = 90;
const rawFanoutCacheTtl = Number(process.env.PRESENCE_FANOUT_CACHE_TTL_SECONDS || 120);
const PRESENCE_FANOUT_CACHE_TTL_SECONDS = Number.isFinite(rawFanoutCacheTtl) && rawFanoutCacheTtl > 0
  ? Math.floor(rawFanoutCacheTtl)
  : 120;

function presenceStatusKey(userId) {
  return `presence:${userId}`;
}

function awayMessageKey(userId) {
  return `presence:${userId}:away_message`;
}

function connectionSetKey(userId) {
  return `user:${userId}:connections`;
}

function connectionStatusHashKey(userId) {
  return `user:${userId}:connection_status`;
}

function fanoutTargetsKey(userId) {
  return `presence:${userId}:fanout_targets`;
}

async function invalidatePresenceFanoutTargets(userId) {
  await redis.del(fanoutTargetsKey(userId));
}

async function getPresenceFanoutTargets(userId) {
  const cacheKey = fanoutTargetsKey(userId);
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return {
        communityIds: Array.isArray(parsed.communityIds) ? parsed.communityIds : [],
        conversationIds: Array.isArray(parsed.conversationIds) ? parsed.conversationIds : [],
      };
    } catch {
      await redis.del(cacheKey);
    }
  }

  const { rows } = await pool.query(
    `SELECT 'community' AS target_type, community_id::text AS target_id
       FROM community_members
      WHERE user_id = $1
      UNION ALL
     SELECT 'conversation' AS target_type, conversation_id::text AS target_id
       FROM conversation_participants
      WHERE user_id = $1
        AND left_at IS NULL`,
    [userId],
  );

  const targets = { communityIds: [], conversationIds: [] };
  for (const row of rows) {
    if (row.target_type === 'community') targets.communityIds.push(row.target_id);
    if (row.target_type === 'conversation') targets.conversationIds.push(row.target_id);
  }

  await redis.set(
    cacheKey,
    JSON.stringify(targets),
    'EX',
    PRESENCE_FANOUT_CACHE_TTL_SECONDS,
  );

  return targets;
}

function normalizeAwayMessage(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 280);
}

async function setAwayMessage(userId, message) {
  const normalized = normalizeAwayMessage(message);
  if (!normalized) {
    await redis.del(awayMessageKey(userId));
    return null;
  }
  await redis.set(awayMessageKey(userId), normalized);
  return normalized;
}

async function getAwayMessage(userId) {
  const msg = await redis.get(awayMessageKey(userId));
  return msg || null;
}

async function syncConnectionStatuses(userId, status) {
  const connectionIds = await redis.smembers(connectionSetKey(userId));
  if (!connectionIds.length) return;

  const pipeline = redis.pipeline();
  for (const connectionId of connectionIds) {
    pipeline.hset(connectionStatusHashKey(userId), connectionId, status);
  }
  await pipeline.exec();
}

async function setPresence(userId, status, awayMessage) {
  const key = presenceStatusKey(userId);
  const awayKey = awayMessageKey(userId);
  const [previousStatus, previousAwayMessage] = await Promise.all([
    redis.get(key),
    redis.get(awayKey),
  ]);

  let nextAwayMessage = null;

  if (status === "offline") {
    if (!previousStatus && !previousAwayMessage) {
      return;
    }
    await Promise.all([redis.del(key), redis.del(awayKey)]);
  } else {
    await redis.set(key, status, "EX", TTL_SECONDS);
    if (status === "away") {
      if (awayMessage === undefined) {
        nextAwayMessage = previousAwayMessage || null;
      } else {
        nextAwayMessage = normalizeAwayMessage(awayMessage);
        if (nextAwayMessage) {
          await redis.set(awayKey, nextAwayMessage);
        } else {
          await redis.del(awayKey);
        }
      }
    } else {
      await redis.del(awayKey);
    }

    const unchangedStatus = previousStatus === status;
    const unchangedAwayMessage = status === "away"
      ? (previousAwayMessage || null) === nextAwayMessage
      : !previousAwayMessage;

    if (unchangedStatus && unchangedAwayMessage) {
      return;
    }
  }

  // Under load, preserve explicit away/offline transitions and suppress noisy churn.
  const shouldFanout =
    !overload.shouldThrottlePresenceFanout() ||
    status === "away" ||
    status === "offline";

  presenceFanoutTotal.inc({ status, throttled: String(!shouldFanout) });
  logger.debug({
    event: "presence.fanout",
    userId,
    status,
    throttled: !shouldFanout,
  });

  if (shouldFanout) {
    const payload = {
      event: "presence:updated",
      data: {
        userId,
        status,
        awayMessage: status === "away" ? nextAwayMessage : null,
      },
    };

    await tracer.startActiveSpan("presence.fanout", async (fanoutSpan) => {
      fanoutSpan.setAttributes({ userId, status });
      try {
        // Publish to the user's personal channel first.
        await fanout.publish(`user:${userId}`, payload);

        // Reuse a short-lived Redis cache for fanout targets so high-frequency
        // presence updates do not hammer Postgres as traffic grows.
        try {
          const { communityIds, conversationIds } = await getPresenceFanoutTargets(userId);
          await Promise.allSettled([
            ...communityIds.map((communityId) => {
              const communitySpan = tracer.startSpan(
                "presence.community_fanout",
                {
                  attributes: { communityId, userId, status },
                },
              );
              return fanout
                .publish(`community:${communityId}`, payload)
                .finally(() => communitySpan.end());
            }),
            ...conversationIds.map((conversationId) =>
              fanout.publish(`conversation:${conversationId}`, payload),
            ),
          ]);
        } catch (err) {
          logger.debug({ err, userId }, 'Presence secondary fanout lookup failed');
        }
      } finally {
        fanoutSpan.end();
      }
    });
  }

  if (!overload.shouldSkipPresenceMirror()) {
    // Mirror to Postgres (non-blocking)
    pool
      .query(
        `INSERT INTO presence_snapshots (user_id, status, custom_msg, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id) DO UPDATE SET status=$2, custom_msg=$3, updated_at=NOW()`,
        [userId, status, status === "away" ? nextAwayMessage : null],
      )
      .catch(() => {});
  }
}

async function getPresence(userId) {
  const val = await redis.get(presenceStatusKey(userId));
  return val || "offline";
}

async function getPresenceDetails(userId) {
  const status = await getPresence(userId);
  const awayMessage = status === "away" ? await getAwayMessage(userId) : null;
  return { status, awayMessage };
}

async function getBulkPresence(userIds) {
  if (!userIds.length) return {};
  const keys = userIds.map((id) => presenceStatusKey(id));
  const values = await redis.mget(...keys);
  return Object.fromEntries(
    userIds.map((id, i) => [id, values[i] || "offline"]),
  );
}

async function getBulkPresenceDetails(userIds) {
  if (!userIds.length) return {};
  const statusKeys = userIds.map((id) => presenceStatusKey(id));
  const msgKeys = userIds.map((id) => awayMessageKey(id));
  const [statuses, awayMessages] = await Promise.all([
    redis.mget(...statusKeys),
    redis.mget(...msgKeys),
  ]);

  const details = {};
  userIds.forEach((id, index) => {
    const status = statuses[index] || "offline";
    const awayMessage = status === "away" ? awayMessages[index] || null : null;
    details[id] = { status, awayMessage };
  });
  return details;
}

module.exports = {
  setPresence,
  setAwayMessage,
  getAwayMessage,
  syncConnectionStatuses,
  invalidatePresenceFanoutTargets,
  getPresence,
  getPresenceDetails,
  getBulkPresence,
  getBulkPresenceDetails,
};
