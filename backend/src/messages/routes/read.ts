/**
 * PUT /messages/:id/read
 * PUT /messages/batch-read — batched read receipts (same semantics per message; one HTTP round-trip).
 *
 * Log prefix: `PUT /messages:` for grep.
 * Core handlers: `../readReceipt/readReceiptHttpCore`.
 */


const { param, body } = require("express-validator");
const { validate } = require("./validation");
const {
  readReceiptPreflightResponse,
  executeReadReceiptMark,
  sortMessageIdsByCreatedAtDesc,
  normalizeBatchReads,
  orderBatchReadResultsByClientIndex,
} = require("../readReceipt/readReceiptHttpCore");

module.exports = function registerReadRoutes(router) {
  // --- PUT /messages/batch-read (must register before /:id/read) ---
  router.put(
    "/batch-read",
    body("reads").isArray({ min: 1 }),
    async (req, res, next) => {
      if (!validate(req, res)) return;
      const parsed = normalizeBatchReads(req.body.reads);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }
      const pre = readReceiptPreflightResponse();
      if (pre.respond) {
        return res.status(pre.status).json({
          ...pre.body,
          batch: true,
        });
      }
      const { messageIds, reads } = parsed;
      const readByMessageId = new Map<string, { messageId: string; hint: unknown }>(
        reads.map((entry) => [entry.messageId, entry]),
      );
      try {
        const sortedIds = await sortMessageIdsByCreatedAtDesc(messageIds);
        const results = [];
        for (const messageId of sortedIds) {
          const readEntry = readByMessageId.get(messageId) as
            | { messageId: string; hint: unknown }
            | undefined;
          const out = await executeReadReceiptMark(
            req.user.id,
            messageId,
            pre.dropReadReceiptFanout,
            { hint: readEntry?.hint },
          );
          results.push({
            messageId,
            status: out.status,
            ...out.body,
          });
        }
        orderBatchReadResultsByClientIndex(results, messageIds);
        return res.json({ success: true, results });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- PUT /messages/:id/read: read receipt ---
  router.put("/:id/read", param("id").isUUID(), async (req, res, next) => {
    if (!validate(req, res)) return;
    const pre = readReceiptPreflightResponse();
    if (pre.respond) {
      return res.status(pre.status).json(pre.body);
    }
    try {
      const out = await executeReadReceiptMark(
        req.user.id,
        req.params.id,
        pre.dropReadReceiptFanout,
        { hint: req.body },
      );
      return res.status(out.status).json(out.body);
    } catch (err) {
      next(err);
    }
  });
};
