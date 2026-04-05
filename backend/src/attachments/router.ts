/**
 * Attachments router
 *
 * POST /api/v1/attachments/presign  – return pre-signed S3 PUT URL (client uploads directly)
 * POST /api/v1/attachments          – record attachment metadata after upload
 * GET  /api/v1/attachments/:id      – get attachment info (returns a pre-signed GET URL)
 */

'use strict';

const express   = require('express');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }  = require('uuid');
const { body, param, validationResult } = require('express-validator');

const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const overload = require('../utils/overload');
const { s3, BUCKET, toClientFacingUrl } = require('./storage');

const router = express.Router();
router.use(authenticate);

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB per image

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// ── Pre-sign ───────────────────────────────────────────────────────────────────
router.post('/presign',
  body('filename').isString().isLength({ max: 255 }),
  body('contentType').isIn([...ALLOWED_TYPES]),
  body('sizeBytes').isInt({ min: 1, max: MAX_SIZE_BYTES }),
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
      const key = `uploads/${req.user.id}/${uuidv4()}.${ext}`;

      const cmd = new PutObjectCommand({
        Bucket:        BUCKET,
        Key:           key,
        ContentType:   contentType,
        ContentLength: sizeBytes,
        Metadata: { uploaderId: req.user.id },
      });

      const url = toClientFacingUrl(await getSignedUrl(s3, cmd, { expiresIn: 300 }));

      res.json({ uploadUrl: url, storageKey: key });
    } catch (err) { next(err); }
  }
);

// ── Record metadata after upload ───────────────────────────────────────────────
router.post('/',
  body('messageId').isUUID(),
  body('storageKey').isString().isLength({ max: 512 }),
  body('filename').isString().isLength({ max: 255 }),
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
         VALUES ($1,$2,'image',$3,$4,$5,$6,$7,$8) RETURNING *`,
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
      // Join through messages to get channel/conversation context for access control.
      const { rows } = await query(`
        SELECT a.*, m.channel_id, m.conversation_id
        FROM attachments a
        JOIN messages m ON m.id = a.message_id
        WHERE a.id = $1
      `, [req.params.id]);

      if (!rows.length) return res.status(404).json({ error: 'Not found' });

      const attachment = rows[0];

      // Enforce that the requester is a member of the channel or conversation
      // the attachment's message belongs to.
      if (attachment.channel_id) {
        const { rows: access } = await query(
          `SELECT 1 FROM channels WHERE id = $1
           AND (is_private = FALSE OR EXISTS (
             SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2
           ))`,
          [attachment.channel_id, req.user.id]
        );
        if (!access.length) return res.status(403).json({ error: 'Access denied' });
      } else if (attachment.conversation_id) {
        const { rows: access } = await query(
          `SELECT 1 FROM conversation_participants
           WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [attachment.conversation_id, req.user.id]
        );
        if (!access.length) return res.status(403).json({ error: 'Access denied' });
      }

      // Strip join-only columns from the client response
      const { channel_id, conversation_id, ...clientAttachment } = attachment;
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: attachment.storage_key });
      const url = toClientFacingUrl(await getSignedUrl(s3, cmd, { expiresIn: 3600 }));

      res.json({ attachment: clientAttachment, url });
    } catch (err) { next(err); }
  }
);

module.exports = router;
