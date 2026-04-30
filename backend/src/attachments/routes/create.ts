/**
 * POST /attachments — record metadata after upload
 */

const { body, validationResult } = require("express-validator");

const { query } = require("../../db/pool");
const {
  ATTACHMENT_RETURNING_FIELDS,
  ALLOWED_TYPES,
  MAX_IMAGES_PER_MESSAGE,
} = require("../constants");

module.exports = function registerAttachmentCreateRoutes(router: import("express").IRouter) {
  router.post(
    "/",
    body("messageId").isUUID(),
    body("storageKey").isString(),
    body("filename").isString(),
    body("contentType").isIn([...ALLOWED_TYPES]),
    body("sizeBytes").isInt({ min: 1 }),
    body("width").optional().isInt(),
    body("height").optional().isInt(),
    async (req: any, res: any, next: any) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const { messageId, storageKey, filename, contentType, sizeBytes, width, height } = req.body;

        const { rows: msgRows } = await query(
          `SELECT id FROM messages WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`,
          [messageId, req.user.id],
        );
        if (!msgRows.length) {
          return res.status(403).json({ error: "Message not found or not yours" });
        }

        const { rows: existing } = await query(
          "SELECT COUNT(*) FROM attachments WHERE message_id=$1",
          [messageId],
        );
        if (parseInt(existing[0].count, 10) >= MAX_IMAGES_PER_MESSAGE) {
          return res.status(400).json({ error: `Max ${MAX_IMAGES_PER_MESSAGE} attachments per message` });
        }

        const { rows } = await query(
          `INSERT INTO attachments (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key, width, height)
         VALUES ($1,$2,'image',$3,$4,$5,$6,$7,$8) RETURNING ${ATTACHMENT_RETURNING_FIELDS}`,
          [
            messageId,
            req.user.id,
            filename,
            contentType,
            sizeBytes,
            storageKey,
            width || null,
            height || null,
          ],
        );

        res.status(201).json({ attachment: rows[0] });
      } catch (err) {
        next(err);
      }
    },
  );
};
