/**
 * Attachments router
 *
 * POST /api/v1/attachments/presign  – return pre-signed S3 PUT URL (client uploads directly)
 * POST /api/v1/attachments          – record attachment metadata after upload
 * GET  /api/v1/attachments/:id      – get attachment info (returns a pre-signed GET URL)
 */


const express   = require('express');
const { randomUUID } = require('crypto');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { body, param, validationResult } = require('express-validator');

const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const overload = require('../utils/overload');
const {
  s3Presign,
  BUCKET,
  toClientFacingUrl,
  assertDirectPresignedUrlMatchesSigner,
} = require('./storage');
const { loadAttachmentForUser } = require('./accessCache');

const router = express.Router();
router.use(authenticate);

const MAX_IMAGES_PER_MESSAGE = 4;
const ATTACHMENT_RETURNING_FIELDS = `
  id,
  message_id,
  uploader_id,
  type,
  filename,
  content_type,
  size_bytes,
  storage_key,
  width,
  height,
  created_at`;

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Some Node / Express stacks end up with Content-Length on the SDK request while presigning; if SigV4
// signs it, the client PUT (different length) fails with MinIO SignatureDoesNotMatch.
const PRESIGN_UNSIGNABLE_HEADERS = new Set(['content-length']);

// ── Pre-sign ───────────────────────────────────────────────────────────────────
router.post('/presign',
  body('filename').isString(),
  body('contentType').isIn([...ALLOWED_TYPES]),
  body('sizeBytes').isInt({ min: 1 }),
  body('messageId').optional().isUUID(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    // Reject presign requests under stage-2+ load: S3 signing is non-essential
    // and the subsequent upload would also fail to reach the DB anyway.
    if (overload.shouldDeferSearchIndexing()) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'Server busy, please retry' });
    }

    try {
      const { filename, contentType, sizeBytes } = req.body;
      const ext = filename.split('.').pop().toLowerCase();
      const key = `uploads/${req.user.id}/${randomUUID()}.${ext}`;

      // No Metadata: presigned PUT would require matching x-amz-meta-* headers (403 otherwise).
      // Omit ContentLength: SigV4 binds content-length; Node fetch / some proxies send a length
      // MinIO rejects with 403. sizeBytes is still validated here; browsers’ fetch(File) work either way.
      const cmd = new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         key,
        ContentType: contentType,
      });

      const url = toClientFacingUrl(
        await getSignedUrl(s3Presign, cmd, {
          expiresIn: 300,
          unsignableHeaders: PRESIGN_UNSIGNABLE_HEADERS,
        }),
      );
      assertDirectPresignedUrlMatchesSigner(url);

      res.json({ uploadUrl: url, storageKey: key });
    } catch (err) {
      if (err && err.statusCode === 500 && err.message) {
        return res.status(500).json({ error: err.message });
      }
      next(err);
    }
  }
);

// ── Record metadata after upload ───────────────────────────────────────────────
router.post('/',
  body('messageId').isUUID(),
  body('storageKey').isString(),
  body('filename').isString(),
  body('contentType').isIn([...ALLOWED_TYPES]),
  body('sizeBytes').isInt({ min: 1 }),
  body('width').optional().isInt(),
  body('height').optional().isInt(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { messageId, storageKey, filename, contentType, sizeBytes, width, height } = req.body;

      // Verify the message exists and belongs to the requesting user so that
      // one user cannot record attachments against another user's message.
      const { rows: msgRows } = await query(
        `SELECT id FROM messages WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`,
        [messageId, req.user.id]
      );
      if (!msgRows.length) {
        return res.status(403).json({ error: 'Message not found or not yours' });
      }

      // Enforce per-message attachment limit
      const { rows: existing } = await query(
        'SELECT COUNT(*) FROM attachments WHERE message_id=$1', [messageId]
      );
      if (parseInt(existing[0].count, 10) >= MAX_IMAGES_PER_MESSAGE) {
        return res.status(400).json({ error: `Max ${MAX_IMAGES_PER_MESSAGE} attachments per message` });
      }

      const { rows } = await query(
        `INSERT INTO attachments (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key, width, height)
         VALUES ($1,$2,'image',$3,$4,$5,$6,$7,$8) RETURNING ${ATTACHMENT_RETURNING_FIELDS}`,
        [messageId, req.user.id, filename, contentType, sizeBytes, storageKey, width || null, height || null]
      );

      res.status(201).json({ attachment: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── Get signed download URL ────────────────────────────────────────────────────
router.get('/:id',
  param('id').isUUID(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const access = await loadAttachmentForUser(req.params.id, req.user.id);
      if (!access?.found) return res.status(404).json({ error: 'Not found' });
      if (!access.allowed) return res.status(403).json({ error: 'Access denied' });
      const attachment = access.attachment;

      // Strip join-only columns from the client response
      const { channel_id, conversation_id, ...clientAttachment } = attachment;
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: attachment.storage_key });
      const url = toClientFacingUrl(
        await getSignedUrl(s3Presign, cmd, {
          expiresIn: 3600,
          unsignableHeaders: PRESIGN_UNSIGNABLE_HEADERS,
        }),
      );
      assertDirectPresignedUrlMatchesSigner(url);

      res.json({ attachment: clientAttachment, url });
    } catch (err) {
      if (err && err.statusCode === 500 && err.message) {
        return res.status(500).json({ error: err.message });
      }
      next(err);
    }
  }
);

module.exports = router;
