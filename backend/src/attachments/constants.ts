/**
 * Shared SQL / validation constants for attachment routes.
 */

export const MAX_IMAGES_PER_MESSAGE = 4;

export const ATTACHMENT_RETURNING_FIELDS = `
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

export const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Headers that must not be bound into SigV4 for presigned PUT (client length differs). */
export const PRESIGN_UNSIGNABLE_HEADERS = new Set(["content-length"]);
