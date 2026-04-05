/**
 * Attachments router
 *
 * POST /api/v1/attachments/presign  – return pre-signed S3 PUT URL (client uploads directly)
 * POST /api/v1/attachments          – record attachment metadata after upload
 * GET  /api/v1/attachments/:id      – get attachment info (returns a pre-signed GET URL)
 */

'use strict';

const express   = require('express');
const { URL } = require('url');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }  = require('uuid');
const { body, param, validationResult } = require('express-validator');

const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const overload = require('../utils/overload');

const router = express.Router();
router.use(authenticate);

const BUCKET  = process.env.S3_BUCKET  || 'chatapp-attachments';
const REGION  = process.env.S3_REGION  || 'us-east-1';
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB per image

function normalizeEndpoint(value) {
  return (value || '').trim().replace(/\/+$/, '');
}

function parseEndpoint(value) {
  const normalized = normalizeEndpoint(value);
  if (!normalized) return null;

  try {
    const endpoint = new URL(normalized);
    const pathname = endpoint.pathname && endpoint.pathname !== '/'
      ? endpoint.pathname.replace(/\/+$/, '')
      : '';
    return {
      href: normalized,
      origin: endpoint.origin,
      host: endpoint.host,
      pathname,
    };
  } catch {
    return null;
  }
}

function resolveInternalEndpoint() {
  const explicit = normalizeEndpoint(process.env.S3_INTERNAL_ENDPOINT);
  if (explicit) return explicit;

  const publicEndpoint = parseEndpoint(process.env.S3_ENDPOINT);
  if (publicEndpoint?.pathname) {
    return 'http://127.0.0.1:9000';
  }

  return normalizeEndpoint(process.env.S3_ENDPOINT);
}

function stripBasePath(pathname, basePath) {
  if (!basePath) return pathname || '/';
  if (pathname === basePath) return '/';
  if (pathname?.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || '/';
  return pathname || '/';
}

function joinPath(basePath, suffix) {
  const normalizedSuffix = suffix && suffix !== '/' ? (suffix.startsWith('/') ? suffix : `/${suffix}`): '';
  if (!basePath) return normalizedSuffix || '/';
  return `${basePath}${normalizedSuffix}`.replace(/\/{2,}/g, '/');
}

const PUBLIC_ENDPOINT = parseEndpoint(process.env.S3_ENDPOINT);
const INTERNAL_ENDPOINT = parseEndpoint(resolveInternalEndpoint());

function toClientFacingUrl(urlString) {
  if (!PUBLIC_ENDPOINT || !INTERNAL_ENDPOINT) return urlString;
  if (PUBLIC_ENDPOINT.href === INTERNAL_ENDPOINT.href) return urlString;

  const signed = new URL(urlString);
  const suffixPath = stripBasePath(signed.pathname, INTERNAL_ENDPOINT.pathname);
  const clientUrl = new URL(PUBLIC_ENDPOINT.origin);

  clientUrl.pathname = joinPath(PUBLIC_ENDPOINT.pathname, suffixPath);
  clientUrl.search = signed.search;
  return clientUrl.toString();
}

const s3 = new S3Client({
  region: REGION,
  endpoint: INTERNAL_ENDPOINT?.href,
  forcePathStyle: !!INTERNAL_ENDPOINT,
  credentials: process.env.S3_ACCESS_KEY ? {
    accessKeyId:     process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  } : undefined, // falls back to IAM role in EC2/ECS
});

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
    try {
      const { rows } = await query('SELECT * FROM attachments WHERE id=$1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });

      const attachment = rows[0];
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: attachment.storage_key });
      const url = toClientFacingUrl(await getSignedUrl(s3, cmd, { expiresIn: 3600 }));

      res.json({ attachment, url });
    } catch (err) { next(err); }
  }
);

module.exports = router;
