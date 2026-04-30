/**
 * POST /messages idempotency: Redis lease polling, replay body hydration, TTL constants.
 */


const redis = require("../../db/redis");
const {
  messagePostIdempotencyPollTotal,
  messagePostIdempotencyPollWaitMs,
} = require("../../utils/metrics");
const { loadHydratedMessageById } = require("../messageHydrate");

const _idemPendingTtl = parseInt(
  process.env.MSG_IDEM_PENDING_TTL_SECS || "120",
  10,
);
/** Lease TTL for in-flight POST /messages idempotency (seconds). */
const MSG_IDEM_PENDING_TTL_SECS =
  Number.isFinite(_idemPendingTtl) && _idemPendingTtl > 0
    ? _idemPendingTtl
    : 120;
const _idemSuccessTtl = parseInt(
  process.env.MSG_IDEM_SUCCESS_TTL_SECS || "86400",
  10,
);
/** How long to remember a successful idempotent POST /messages (seconds). */
const MSG_IDEM_SUCCESS_TTL_SECS =
  Number.isFinite(_idemSuccessTtl) && _idemSuccessTtl > 0
    ? _idemSuccessTtl
    : 86400;
const _idemPollDeadlineMs = parseInt(
  process.env.MSG_IDEM_POLL_DEADLINE_MS || "5000",
  10,
);
/** Max wall-clock wait when a duplicate Idempotency-Key hits an in-flight lease (was fixed 100ms × 50). */
const MSG_IDEM_POLL_DEADLINE_MS =
  Number.isFinite(_idemPollDeadlineMs) && _idemPollDeadlineMs > 0
    ? Math.min(30000, Math.max(500, Math.floor(_idemPollDeadlineMs)))
    : 5000;
const _idemPollMaxSleepMs = parseInt(
  process.env.MSG_IDEM_POLL_MAX_SLEEP_MS || "150",
  10,
);
/** Cap for exponential backoff between Redis polls while waiting on the idempotency lease. */
const MSG_IDEM_POLL_MAX_SLEEP_MS =
  Number.isFinite(_idemPollMaxSleepMs) && _idemPollMaxSleepMs >= 5
    ? Math.min(500, Math.floor(_idemPollMaxSleepMs))
    : 150;

/** Message row `created_at` as ISO string (idempotent POST replays). */
function messageCreatedAtIso(row) {
  const t = row?.created_at ?? row?.createdAt;
  if (t instanceof Date) return t.toISOString();
  if (typeof t === "string") return new Date(t).toISOString();
  return new Date().toISOString();
}

function buildIdempotentSuccessPayload(payload: any) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.message ||
    typeof payload.message !== "object"
  ) {
    return null;
  }
  if (!payload.message.id || typeof payload.message.id !== "string") {
    return null;
  }
  const publishedAt =
    typeof payload.realtimePublishedAt === "string"
      ? payload.realtimePublishedAt
      : messageCreatedAtIso(payload.message);
  const msg = payload.message;
  const out: Record<string, unknown> = {
    message: msg,
    realtimePublishedAt: publishedAt,
  };
  if (msg.channel_id) {
    out.realtimeChannelFanoutComplete =
      payload.realtimeChannelFanoutComplete !== false;
    out.realtimeUserFanoutDeferred =
      payload.realtimeUserFanoutDeferred === true;
  } else if (msg.conversation_id) {
    out.realtimeConversationFanoutComplete =
      payload.realtimeConversationFanoutComplete !== false;
  }
  return out;
}

/** Replay body for Redis idempotency value (legacy full `message` blob or slim `messageId` + flags). */
async function hydrateIdemReplayBody(parsed: any): Promise<Record<string, unknown> | null> {
  const legacy = buildIdempotentSuccessPayload(parsed);
  if (legacy) return legacy;
  const mid = parsed?.messageId;
  if (!mid || typeof mid !== "string") return null;
  const msg = await loadHydratedMessageById(mid);
  if (!msg) return null;
  const publishedAt =
    typeof parsed?.realtimePublishedAt === "string"
      ? parsed.realtimePublishedAt
      : messageCreatedAtIso(msg);
  if (msg.channel_id) {
    return {
      message: msg,
      realtimePublishedAt: publishedAt,
      realtimeChannelFanoutComplete:
        parsed.realtimeChannelFanoutComplete !== false,
      realtimeUserFanoutDeferred: parsed.realtimeUserFanoutDeferred === true,
    };
  }
  return {
    message: msg,
    realtimePublishedAt: publishedAt,
    realtimeConversationFanoutComplete:
      parsed.realtimeConversationFanoutComplete !== false,
  };
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Second client with the same Idempotency-Key: Redis NX failed — wait for the
 * first POST to finish (exponential backoff, same default deadline as legacy 50×100ms).
 * Records `message_post_idempotency_poll_*` for proof in Prometheus.
 */
async function awaitIdempotentPostAfterLeaseContention(idemRedisKey: string) {
  const deadline = Date.now() + MSG_IDEM_POLL_DEADLINE_MS;
  let sleepStep = 5;
  const pollStart = Date.now();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(
      MSG_IDEM_POLL_MAX_SLEEP_MS,
      Math.max(1, sleepStep),
      remaining,
    );
    await sleepMs(wait);
    sleepStep = Math.min(MSG_IDEM_POLL_MAX_SLEEP_MS, sleepStep * 2);

    const again = await redis.get(idemRedisKey);
    if (!again) break;
    let p2;
    try {
      p2 = JSON.parse(again);
    } catch {
      break;
    }
    const replay = await hydrateIdemReplayBody(p2);
    if (replay) {
      messagePostIdempotencyPollTotal.inc({ outcome: "replay_201" });
      messagePostIdempotencyPollWaitMs.observe(
        { outcome: "replay_201" },
        Date.now() - pollStart,
      );
      return { ok: true as const, body: replay };
    }
    if (!p2?.pending) break;
  }
  messagePostIdempotencyPollTotal.inc({ outcome: "exhausted_409" });
  messagePostIdempotencyPollWaitMs.observe(
    { outcome: "exhausted_409" },
    Date.now() - pollStart,
  );
  return { ok: false as const };
}

module.exports = {
  MSG_IDEM_PENDING_TTL_SECS,
  MSG_IDEM_SUCCESS_TTL_SECS,
  MSG_IDEM_POLL_DEADLINE_MS,
  MSG_IDEM_POLL_MAX_SLEEP_MS,
  messageCreatedAtIso,
  buildIdempotentSuccessPayload,
  hydrateIdemReplayBody,
  awaitIdempotentPostAfterLeaseContention,
};
