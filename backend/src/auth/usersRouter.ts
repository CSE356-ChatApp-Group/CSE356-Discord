/**
 * Users routes
 *
 * GET   /api/v1/users              – search users by ?q=
 * GET   /api/v1/users/me           – own profile
 * PATCH /api/v1/users/me           – update profile
 * POST  /api/v1/users/me/avatar    – upload avatar image
 * GET   /api/v1/users/:id          – public profile
 * GET   /api/v1/users/:id/avatar   – serve avatar image
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const { hashPassword } = require('./passwords');
const presenceService  = require('../presence/service');
const { BUCKET, s3 } = require('../utils/objectStorage');

const router = express.Router();

const PUBLIC_FIELDS = 'id, username, display_name, avatar_url, bio, created_at, last_seen_at';
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// multer in-memory, 5 MB max, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    cb(null, ALLOWED_IMAGE_TYPES.includes(file.mimetype));
  },
});

function fileExtension(file) {
  const originalName = file?.originalname || '';
  const dotIndex = originalName.lastIndexOf('.');
  if (dotIndex !== -1 && dotIndex < originalName.length - 1) {
    return originalName.slice(dotIndex + 1).toLowerCase();
  }

  switch (file?.mimetype) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'bin';
  }
}

async function bodyToBuffer(body) {
  if (!body) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    body.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    body.on('end', () => resolve(Buffer.concat(chunks)));
    body.on('error', reject);
  });
}

async function uploadAvatarObject(userId, file) {
  const storageKey = `avatars/${userId}/${uuidv4()}.${fileExtension(file)}`;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    Body: file.buffer,
    ContentType: file.mimetype,
    ContentLength: file.size,
    CacheControl: 'public, max-age=3600',
    Metadata: {
      uploaderId: userId,
      kind: 'avatar',
    },
  }));

  return storageKey;
}

async function saveAvatarForUser(userId, file) {
  const { rows: existingRows } = await query(
    'SELECT avatar_storage_key FROM users WHERE id = $1',
    [userId]
  );
  if (!existingRows.length) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }

  const previousStorageKey = existingRows[0].avatar_storage_key || null;
  const storageKey = await uploadAvatarObject(userId, file);
  const avatarUrl = `/api/v1/users/${userId}/avatar`;

  try {
    await query(
      `UPDATE users
       SET avatar_url=$2,
           avatar_storage_key=$3,
           avatar_data=NULL,
           avatar_content_type=$4,
           updated_at=NOW()
       WHERE id=$1`,
      [userId, avatarUrl, storageKey, file.mimetype]
    );
  } catch (err) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey })).catch(() => {});
    throw err;
  }

  if (previousStorageKey && previousStorageKey !== storageKey) {
    s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: previousStorageKey })).catch(() => {});
  }

  const { rows } = await query(`SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`, [userId]);
  return rows[0];
}

// ── Search users (no auth required, returns public fields) ─────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt((req.query.limit || '25').toString(), 10) || 25, 100);
    if (!q) {
      return res.status(400).json({ error: 'q query param required' });
    }
    const pattern = `%${q}%`;
    const { rows } = await query(
      `SELECT ${PUBLIC_FIELDS}
       FROM   users
       WHERE  is_active = TRUE
         AND  (username ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1)
       ORDER  BY username
       LIMIT  $2`,
      [pattern, limit]
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

// ── Serve avatar image (public — browsers cannot send Authorization via <img>) ──
router.get('/:id/avatar', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT avatar_storage_key, avatar_data, avatar_content_type FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No avatar' });
    }

    const avatar = rows[0];
    if (avatar.avatar_storage_key) {
      try {
        const object = await s3.send(new GetObjectCommand({
          Bucket: BUCKET,
          Key: avatar.avatar_storage_key,
        }));
        const data = await bodyToBuffer(object.Body);
        if (!data) return res.status(404).json({ error: 'No avatar' });

        res.setHeader('Content-Type', avatar.avatar_content_type || object.ContentType || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(data);
      } catch (err) {
        const missing = err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
        if (!missing) throw err;
      }
    }

    if (!avatar.avatar_data) {
      return res.status(404).json({ error: 'No avatar' });
    }

    res.setHeader('Content-Type', avatar.avatar_content_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(avatar.avatar_data);
  } catch (err) { next(err); }
});

router.use(authenticate);

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { status, awayMessage } = await presenceService.getPresenceDetails(req.user.id);
    res.json({ user: { ...rows[0], status, away_message: awayMessage } });
  } catch (err) { next(err); }
});

router.patch('/me',
  body('displayName').optional().isLength({ min: 1, max: 64 }),
  body('bio').optional().isLength({ max: 500 }),
  body('password').optional().isLength({ min: 8 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const updates: Record<string, unknown> = {};
      if (req.body.displayName) updates.display_name = req.body.displayName;
      if (req.body.bio !== undefined) updates.bio = req.body.bio;
      if (req.body.password) updates.password_hash = await hashPassword(req.body.password, 'user_update_hash');

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

      const setClauses = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
      const { rows } = await query(
        `UPDATE users SET ${setClauses}, updated_at=NOW() WHERE id=$1 RETURNING ${PUBLIC_FIELDS}, email`,
        [req.user.id, ...Object.values(updates)]
      );
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── Avatar upload ──────────────────────────────────────────────────────────────
router.post('/me/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided (field: avatar)' });
    const user = await saveAvatarForUser(req.user.id, req.file);
    res.json({ user });
  } catch (err) { next(err); }
});

// Also accept PUT for compatibility
router.put('/me/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided (field: avatar)' });
    const user = await saveAvatarForUser(req.user.id, req.file);
    res.json({ user });
  } catch (err) { next(err); }
});

// ── Serve avatar image ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    // Include email so clients can map SSO usernames
    const { rows } = await query(
      `SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { status, awayMessage } = await presenceService.getPresenceDetails(req.params.id);
    res.json({ user: { ...rows[0], status, away_message: awayMessage } });
  } catch (err) { next(err); }
});

module.exports = router;
