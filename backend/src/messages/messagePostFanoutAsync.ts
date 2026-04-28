/**
 * Deferred POST /messages Redis fanout: dedupe by messageId, bounded retries,
 * done marker to suppress duplicate delivery after success.
 */

"use strict";

const redis = require("../db/redis");
const logger = require("../utils/logger");
const {
  messagePostFanoutJobTotal,
  messagePostFanoutJobRetriesTotal,
  messagePostFanoutJobDurationMs,
  fanoutJobLatencyMs,
  fanoutRetryTotal,
  messagePostRealtimePublishFailTotal,
} = require("../utils/metrics");

const DONE_PREFIX = "fanout:v1:done:";
const LOCK_PREFIX = "fanout:v1:lock:";

function lockTtlSec() {
  const raw = parseInt(process.env.MESSAGE_FANOUT_JOB_LOCK_TTL_SEC || "300", 10);
  return Number.isFinite(raw) ? Math.min(900, Math.max(60, raw)) : 300;
}

function doneTtlSec() {
  const raw = parseInt(process.env.MESSAGE_FANOUT_JOB_DONE_TTL_SEC || "7200", 10);
  return Number.isFinite(raw) ? Math.min(604800, Math.max(3600, raw)) : 7200;
}

function maxAttempts() {
  const raw = parseInt(process.env.MESSAGE_FANOUT_JOB_MAX_ATTEMPTS || "5", 10);
  return Number.isFinite(raw) ? Math.min(10, Math.max(1, raw)) : 5;
}

function baseBackoffMs() {
  const raw = parseInt(process.env.MESSAGE_FANOUT_JOB_BACKOFF_MS_BASE || "100", 10);
  return Number.isFinite(raw) ? Math.min(2000, Math.max(25, raw)) : 100;
}

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param path - `channel` | `conversation` (metric label)
 * @param messageId - committed message id
 * @param runPublishOnce - load row + publish (throws on Redis/DB failure)
 */
async function runPostMessageFanoutJob(
  path: string,
  messageId: string,
  runPublishOnce: () => Promise<void>,
) {
  const doneKey = `${DONE_PREFIX}${messageId}`;
  const existing = await redis.get(doneKey);
  if (existing) {
    messagePostFanoutJobTotal.inc({ path, result: "dedup_skip" });
    return;
  }

  const lockKey = `${LOCK_PREFIX}${messageId}`;
  const locked = await redis.set(lockKey, "1", "EX", lockTtlSec(), "NX");
  if (locked !== "OK") {
    messagePostFanoutJobTotal.inc({ path, result: "dedup_skip" });
    return;
  }

  const jobStarted = Date.now();
  try {
    const attempts = maxAttempts();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runPublishOnce();
        await redis.set(doneKey, "1", "EX", doneTtlSec());
        messagePostFanoutJobTotal.inc({ path, result: "success" });
        const successMs = Date.now() - jobStarted;
        messagePostFanoutJobDurationMs.observe(
          { path, result: "success" },
          successMs,
        );
        fanoutJobLatencyMs.observe({ path, result: "success" }, successMs);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < attempts) {
          messagePostFanoutJobRetriesTotal.inc({ path });
          fanoutRetryTotal.inc({ path });
        }
        logger.warn(
          { err, path, messageId, attempt, attempts },
          "message post fanout job publish attempt failed",
        );
        if (attempt < attempts) {
          const delay = Math.min(
            8000,
            baseBackoffMs() * 2 ** (attempt - 1),
          );
          await sleepMs(delay);
        }
      }
    }
    messagePostFanoutJobTotal.inc({ path, result: "dead_letter" });
    const deadMs = Date.now() - jobStarted;
    messagePostFanoutJobDurationMs.observe(
      { path, result: "dead_letter" },
      deadMs,
    );
    fanoutJobLatencyMs.observe({ path, result: "dead_letter" }, deadMs);
    logger.error(
      { err: lastErr, path, messageId, attempts: maxAttempts() },
      "message post fanout job exhausted retries (realtime may lag; replay covers)",
    );
    messagePostRealtimePublishFailTotal.inc({
      target: path === "conversation" ? "conversation" : "channel",
    });
  } catch (err) {
    messagePostFanoutJobTotal.inc({ path, result: "error" });
    const errMs = Date.now() - jobStarted;
    messagePostFanoutJobDurationMs.observe(
      { path, result: "error" },
      errMs,
    );
    fanoutJobLatencyMs.observe({ path, result: "error" }, errMs);
    logger.error({ err, path, messageId }, "message post fanout job unexpected error");
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

module.exports = {
  runPostMessageFanoutJob,
  DONE_PREFIX,
  LOCK_PREFIX,
};
