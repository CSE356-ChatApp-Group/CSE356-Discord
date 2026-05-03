/**
 * DB insert phase for POST /messages (channel serialized path + DM transaction).
 */

const { tracer, trace } = require("../../utils/tracer");
const { SpanStatusCode } = require("@opentelemetry/api");
const { withTransaction, pool } = require("../../db/pool");
const {
  MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS,
  MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS,
} = require("./postConstants");
const {
  runChannelMessageInsertSerialized,
} = require("../channelInsertConcurrency");
const {
  MESSAGE_INSERT_RETURNING_AUTHOR,
  MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL,
  MESSAGE_POST_CHANNEL_INSERT_MERGED_SQL,
} = require("../sqlFragments");
import type { MessagesAuthedRequest } from "./postTypes";

function buildMessagePostError(
  message: string,
  statusCode: number,
  reason: string,
) {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.messagePostDenyReason = reason;
  return err;
}

async function insertMessageAttachments(
  client: any,
  messageId: string,
  uploaderId: string,
  attachments: any[],
) {
  if (attachments.length === 0) return;
  const values: string[] = [];
  const params: any[] = [];
  let index = 1;

  for (const attachment of attachments) {
    values.push(
      `($${index++}, $${index++}, 'image', $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`,
    );
    params.push(
      messageId,
      uploaderId,
      attachment.filename,
      attachment.contentType,
      attachment.sizeBytes,
      attachment.storageKey,
      attachment.width || null,
      attachment.height || null,
    );
  }

  await client.query(
    `INSERT INTO attachments
       (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key, width, height)
     VALUES ${values.join(", ")}`,
    params,
  );
}

async function rollbackInsertedChannelMessage(
  messageId: string,
  channelId: string,
  authorId: string,
) {
  await pool
    .query(
      `DELETE FROM messages WHERE id = $1 AND channel_id = $2 AND author_id = $3`,
      [messageId, channelId, authorId],
    )
    .catch(() => {});
}

async function configureMessageInsertTransaction(
  client: any,
  statementTimeoutMs: number,
) {
  await client.query(
    `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'; SET LOCAL synchronous_commit = off`,
  );
}

async function runChannelInsertTransaction({
  client,
  channelId,
  userId,
  normalizedContent,
  threadId,
  txPhases,
}: {
  client: any;
  channelId: string;
  userId: string;
  normalizedContent: string;
  threadId: string | null;
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
}) {
  txPhases.t0 = Date.now();
  await configureMessageInsertTransaction(
    client,
    MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS,
  );

  txPhases.t_access = Date.now();
  const insertRes = await client.query(MESSAGE_POST_CHANNEL_INSERT_MERGED_SQL, [
    channelId,
    userId,
    normalizedContent || null,
    threadId || null,
  ]);
  txPhases.t_insert = Date.now();

  if (!insertRes.rows.length) {
    const accessRes = await client.query(
      MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL,
      [channelId, userId],
    );
    txPhases.t_later = Date.now();
    const accessRow = accessRes.rows[0];
    if (accessRow && accessRow.author_exists === false) {
      throw buildMessagePostError(
        "Session no longer valid",
        401,
        "author_missing",
      );
    }
    throw buildMessagePostError("Access denied", 403, "channel_access");
  }

  const row = insertRes.rows[0];
  const communityId = row.post_insert_community_id ?? null;
  delete row.post_insert_community_id;
  txPhases.t_later = Date.now();
  return { row, communityId };
}

async function runConversationInsertTransaction({
  client,
  conversationId,
  userId,
  normalizedContent,
  threadId,
  attachments,
  txPhases,
}: {
  client: any;
  conversationId: string;
  userId: string;
  normalizedContent: string;
  threadId: string | null;
  attachments: any[];
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
}) {
  txPhases.t0 = Date.now();
  await configureMessageInsertTransaction(
    client,
    MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS,
  );

  const accessRes = await client.query(
    `SELECT
       EXISTS(SELECT 1 FROM users WHERE id = $2) AS author_exists,
       COUNT(*)::int                             AS has_access
     FROM conversation_participants
     WHERE conversation_id = $1
       AND user_id = $2
       AND left_at IS NULL`,
    [conversationId, userId],
  );
  txPhases.t_access = Date.now();
  const accessRow = accessRes.rows[0];
  if (accessRow && accessRow.author_exists === false) {
    throw buildMessagePostError(
      "Session no longer valid",
      401,
      "author_missing",
    );
  }
  if (!accessRow?.has_access) {
    throw buildMessagePostError(
      "Not a participant",
      403,
      "conversation_participant",
    );
  }

  const insertRes = await client.query(
    `INSERT INTO messages AS m (conversation_id, author_id, content, thread_id)
   VALUES ($1, $2, $3, $4)
   RETURNING ${MESSAGE_INSERT_RETURNING_AUTHOR},
     '[]'::json AS attachments`,
    [conversationId, userId, normalizedContent || null, threadId || null],
  );
  txPhases.t_insert = Date.now();
  const row = insertRes.rows[0];

  await insertMessageAttachments(client, row.id, userId, attachments);

  txPhases.t_later = Date.now();
  return row;
}

async function runPostInsertPhase({
  authReq,
  channelId,
  conversationId,
  userId,
  normalizedContent,
  threadId,
  attachments,
  txPhases,
  setChannelInsertLockMeta,
}: {
  authReq: MessagesAuthedRequest;
  channelId: string | null;
  conversationId: string | null;
  userId: string;
  normalizedContent: string;
  threadId: string | null;
  attachments: any[];
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
  setChannelInsertLockMeta: (meta: {
    waitMs: number;
    lockPath: string | null;
    bypassReasonDetail: unknown;
  }) => void;
}) {
  let communityId: string | null = null;

  trace
    .getActiveSpan()
    ?.setAttribute(
      "message.insert_path",
      channelId ? "channel_merged" : "dm_sequential",
    );

  const runChannelMessageRowUnderInsertLock = () =>
    tracer.startActiveSpan("channel_insert.db_pool", async (span: any) => {
      try {
        return await withTransaction(
          async (client: any) => {
            const { row, communityId: nextCommunityId } =
              await runChannelInsertTransaction({
                client,
                channelId: channelId!,
                userId,
                normalizedContent,
                threadId,
                txPhases,
              });
            communityId = nextCommunityId;
            return row;
          },
          { onCheckout: (acquireMs) => span.setAttribute("pool.acquire_ms", acquireMs) },
        );
      } catch (err: any) {
        const isExpected4xx =
          err.statusCode && err.statusCode >= 400 && err.statusCode < 500;
        if (!isExpected4xx) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(err?.message || ""),
          });
          span.recordException(err);
        }
        throw err;
      } finally {
        span.end();
      }
    });

  let dmPoolAcquireMs = 0;
  const runDmMessageInsertTransaction = () =>
    withTransaction(
      async (client: any) => {
        return runConversationInsertTransaction({
          client,
          conversationId: conversationId!,
          userId,
          normalizedContent,
          threadId,
          attachments,
          txPhases,
        });
      },
      { onCheckout: (acquireMs) => { dmPoolAcquireMs = acquireMs; } },
    );

  let baseMessage: any;
  if (channelId) {
    baseMessage = await tracer.startActiveSpan(
      "db.channel_insert",
      async (span: any) => {
        try {
          const row = await runChannelMessageInsertSerialized(
            channelId,
            runChannelMessageRowUnderInsertLock,
            {
              requestId: authReq.id,
              onInsertLock: ({
                waitMs,
                lockPath,
                bypassReasonDetail,
                leaseHeld,
              }: {
                waitMs: number;
                lockPath: string | null;
                bypassReasonDetail: unknown;
                leaseHeld: boolean;
              }) => {
                setChannelInsertLockMeta({
                  waitMs,
                  lockPath,
                  bypassReasonDetail,
                });
                span.setAttribute("lock.path", lockPath);
                span.setAttribute("lock.wait_ms", waitMs);
                span.setAttribute("lock.held", leaseHeld);
              },
            },
          );
          span.setAttribute(
            "tx.config_ms",
            Math.max(0, txPhases.t_access - txPhases.t0),
          );
          span.setAttribute(
            "tx.merged_sql_ms",
            Math.max(0, txPhases.t_insert - txPhases.t_access),
          );
          span.addEvent(
            "tx.config_done",
            { elapsed_ms: Math.max(0, txPhases.t_access - txPhases.t0) },
            txPhases.t_access,
          );
          span.addEvent(
            "tx.insert_done",
            { elapsed_ms: Math.max(0, txPhases.t_insert - txPhases.t_access) },
            txPhases.t_insert,
          );
          if (attachments.length > 0) {
            span.setAttribute("attachment_count", attachments.length);
            try {
              await tracer.startActiveSpan(
                "channel_insert.attachment_insert",
                async (attachSpan: any) => {
                  try {
                    await withTransaction(async (client: any) => {
                      await client.query(
                        `SET LOCAL statement_timeout = '${MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS}ms'`,
                      );
                      await insertMessageAttachments(
                        client,
                        row.id,
                        userId,
                        attachments,
                      );
                    });
                    attachSpan.setAttribute(
                      "attachment_count",
                      attachments.length,
                    );
                  } catch (err: any) {
                    attachSpan.setStatus({
                      code: SpanStatusCode.ERROR,
                      message: String(err?.message || ""),
                    });
                    attachSpan.recordException(err);
                    throw err;
                  } finally {
                    attachSpan.end();
                  }
                },
              );
            } catch (attachErr) {
              await rollbackInsertedChannelMessage(row.id, channelId, userId);
              throw attachErr;
            }
          }
          return row;
        } catch (err: any) {
          const isExpected4xx =
            err.statusCode && err.statusCode >= 400 && err.statusCode < 500;
          if (!isExpected4xx) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(err?.message || ""),
            });
            span.recordException(err);
          }
          throw err;
        } finally {
          span.end();
        }
      },
    );
  } else {
    baseMessage = await tracer.startActiveSpan(
      "db.dm_insert",
      async (span: any) => {
        try {
          const row = await runDmMessageInsertTransaction();
          span.setAttribute("pool.acquire_ms", dmPoolAcquireMs);
          span.setAttribute(
            "tx.config_ms",
            Math.max(0, txPhases.t_access - txPhases.t0),
          );
          span.setAttribute(
            "tx.access_sql_ms",
            Math.max(0, txPhases.t_insert - txPhases.t_access),
          );
          span.setAttribute(
            "tx.insert_sql_ms",
            Math.max(0, txPhases.t_later - txPhases.t_insert),
          );
          if (attachments.length > 0)
            span.setAttribute("attachment_count", attachments.length);
          return row;
        } catch (err: any) {
          const isExpected4xx =
            err.statusCode && err.statusCode >= 400 && err.statusCode < 500;
          if (!isExpected4xx) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(err?.message || ""),
            });
            span.recordException(err);
          }
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  return { baseMessage, communityId };
}

module.exports = {
  runPostInsertPhase,
};
