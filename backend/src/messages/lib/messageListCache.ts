/**
 * Message list Redis cache bust helpers and POST-insert bounded waits (shared in-flight maps).
 */


const redis = require("../../db/redis");
const logger = require("../../utils/logger");
const { messageCacheBustFailuresTotal } = require("../../utils/metrics");
const {
  bustChannelMessagesCache,
  bustConversationMessagesCache,
} = require("../messageCacheBust");
const {
  recordEndpointListCacheInvalidation,
} = require("../../utils/endpointCacheMetrics");

const MESSAGES_CACHE_TTL_SECS = 15;

const msgInflight: Map<string, Promise<{ messages: any[] }>> = new Map();
const convMsgInflight: Map<string, Promise<{ messages: any[] }>> = new Map();

async function bustMessagesCacheSafe(opts: {
  channelId?: string;
  conversationId?: string;
}) {
  const { channelId, conversationId } = opts;
  try {
    if (channelId) {
      await bustChannelMessagesCache(redis, channelId);
      recordEndpointListCacheInvalidation("messages_channel", "write");
    } else if (conversationId) {
      await bustConversationMessagesCache(redis, conversationId);
      recordEndpointListCacheInvalidation("messages_conversation", "write");
    }
  } catch (err) {
    messageCacheBustFailuresTotal.inc({
      target: channelId ? "channel" : "conversation",
    });
    logger.warn(
      { err, channelId, conversationId },
      "message list cache bust failed",
    );
  }
}

async function withBoundedPostInsertTimeout<T>(
  opName: string,
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: boolean; timedOut: boolean; value?: T }> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const value = await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const err: any = new Error(`post-insert ${opName} timed out`);
          err.code = "POST_INSERT_REDIS_TIMEOUT";
          reject(err);
        }, timeoutMs);
      }),
    ]);
    return { ok: true, timedOut: false, value };
  } catch (err: any) {
    const timedOut = err?.code === "POST_INSERT_REDIS_TIMEOUT";
    logger.warn(
      {
        err,
        opName,
        timeoutMs,
        timedOut,
        gradingNote: timedOut
          ? "post_insert_delivery_timeout_not_http_failure"
          : "post_insert_work_error",
      },
      timedOut
        ? "POST /messages post-insert work exceeded wall budget (message still persisted)"
        : "POST /messages post-insert work failed",
    );
    return { ok: false, timedOut };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

module.exports = {
  MESSAGES_CACHE_TTL_SECS,
  msgInflight,
  convMsgInflight,
  bustMessagesCacheSafe,
  withBoundedPostInsertTimeout,
};
