
/**
 * Shared S3/MinIO clients and helpers for the attachments router and
 * the message side-effects queue (cleanup on message delete).
 *
 * `s3` is for operational calls (DeleteObjects, server-side uploads).
 * `s3Presign` is for getSignedUrl only so presigned Host matches nginx → MinIO.
 */

const { URL } = require('url');
const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const logger = require('../utils/logger');

// ── Configuration ─────────────────────────────────────────────────────────────

const BUCKET = process.env.S3_BUCKET  || 'chatapp-attachments';
const REGION = process.env.S3_REGION  || 'us-east-1';

// ── Endpoint helpers ──────────────────────────────────────────────────────────

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
    return { href: normalized, origin: endpoint.origin, host: endpoint.host, pathname };
  } catch {
    return null;
  }
}

/**
 * When MinIO is exposed via an nginx sub-path (e.g. /minio/), the S3 SDK
 * signs URLs using the internal loopback address (127.0.0.1:9000).
 * Clients need the public-facing URL instead.  Detect the mismatch and
 * fall back to the loopback for the internal signer.
 */
function resolveInternalEndpoint() {
  const explicit = normalizeEndpoint(process.env.S3_INTERNAL_ENDPOINT);
  if (explicit) return explicit;
  // If the public endpoint has a path prefix (e.g. /minio) the signing must
  // use the bare MinIO port; the path prefix is handled by nginx.
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
  const normalizedSuffix = suffix && suffix !== '/'
    ? (suffix.startsWith('/') ? suffix : `/${suffix}`)
    : '';
  if (!basePath) return normalizedSuffix || '/';
  return `${basePath}${normalizedSuffix}`.replace(/\/{2,}/g, '/');
}

const PUBLIC_ENDPOINT   = parseEndpoint(process.env.S3_ENDPOINT);
const INTERNAL_ENDPOINT = parseEndpoint(resolveInternalEndpoint());

/**
 * Host:port used in SigV4 for presigned URLs when S3 is behind nginx (/minio/…).
 * Nginx must forward this exact Host to MinIO (see deploy/nginx/staging.conf).
 * Operational traffic may still use S3_INTERNAL_ENDPOINT (e.g. http://minio:9000 in Docker);
 * getSignedUrl does not open a socket, so this can differ from the operational endpoint.
 *
 * When S3_ENDPOINT has **no** path prefix (direct MinIO from the browser/tests), the client
 * PUTs to that exact origin. SigV4 includes Host — signing with S3_INTERNAL_ENDPOINT while
 * rewriting the URL to S3_ENDPOINT (e.g. sign :9000, client uses :19009) causes
 * SignatureDoesNotMatch on MinIO.
 */
function resolvePresignSignerEndpoint() {
  const pub = parseEndpoint(process.env.S3_ENDPOINT);
  if (pub?.pathname) {
    return normalizeEndpoint(process.env.S3_PRESIGN_SIGNING_ENDPOINT || 'http://127.0.0.1:9000');
  }
  if (pub) {
    return normalizeEndpoint(pub.href);
  }
  return resolveInternalEndpoint();
}

const PRESIGN_SIGNER_ENDPOINT = parseEndpoint(resolvePresignSignerEndpoint());

/**
 * Rewrites an internally-signed URL so that the host/path matches what
 * the client should use.  This is a no-op when PUBLIC and INTERNAL
 * endpoints are the same (real AWS S3) or when neither is configured.
 */
function toClientFacingUrl(urlString) {
  if (!PUBLIC_ENDPOINT || !INTERNAL_ENDPOINT) return urlString;
  if (PUBLIC_ENDPOINT.href === INTERNAL_ENDPOINT.href) return urlString;

  // Presigned URLs only sign `host` (see X-Amz-SignedHeaders). Never rewrite origin
  // host:port here for "direct" S3_ENDPOINT values (no /minio/ prefix): that would point
  // the browser at a different Host than the signature (e.g. sign :9000, URL says :19009
  // → SignatureDoesNotMatch). resolvePresignSignerEndpoint() must already use S3_ENDPOINT
  // for those cases.
  if (!PUBLIC_ENDPOINT.pathname) {
    return urlString;
  }

  const signed = new URL(urlString);
  // Strip using presign signer path (signer is 127.0.0.1:9000 while INTERNAL may be minio:9000).
  const signerPath = PRESIGN_SIGNER_ENDPOINT?.pathname || '';
  const suffixPath = stripBasePath(signed.pathname, signerPath);
  const clientUrl = new URL(PUBLIC_ENDPOINT.origin);
  clientUrl.pathname = joinPath(PUBLIC_ENDPOINT.pathname, suffixPath);
  clientUrl.search = signed.search;
  return clientUrl.toString();
}

/**
 * Direct S3_ENDPOINT (no /minio/ path): clients PUT to that exact host:port. SigV4 only signs `host`,
 * so the presigned URL must use the same host as PRESIGN_SIGNER_ENDPOINT. Otherwise MinIO returns
 * SignatureDoesNotMatch and looks like a "signing bug".
 */
function assertDirectPresignedUrlMatchesSigner(uploadUrlString) {
  if (PUBLIC_ENDPOINT?.pathname) return;
  if (!PRESIGN_SIGNER_ENDPOINT) return;
  let upload;
  let signer;
  try {
    upload = new URL(uploadUrlString);
    signer = new URL(PRESIGN_SIGNER_ENDPOINT.href);
  } catch {
    return;
  }
  if (upload.host !== signer.host) {
    const err = new Error(
      `Presigned URL host "${upload.host}" does not match signing endpoint "${signer.host}". ` +
        'Set S3_ENDPOINT to the same origin used for PUT (e.g. http://127.0.0.1:19009 if that is your published MinIO port).',
    );
    (err as any).statusCode = 500;
    throw err;
  }
}

/** Trim — Docker / .env often introduce trailing newlines; MinIO then returns SignatureDoesNotMatch. */
function s3AccessKeyId() {
  const v = process.env.S3_ACCESS_KEY;
  return typeof v === 'string' ? v.trim() : '';
}

function s3SecretAccessKey() {
  const v = process.env.S3_SECRET_KEY;
  return typeof v === 'string' ? v.trim() : '';
}

const s3Credentials = s3AccessKeyId()
  ? {
      accessKeyId: s3AccessKeyId(),
      secretAccessKey: s3SecretAccessKey(),
    }
  : undefined; // falls back to IAM role in EC2/ECS

// ── S3 clients ───────────────────────────────────────────────────────────────
// Operational: DeleteObjects, server-side uploads (avatars), etc.

const s3 = new S3Client({
  region: REGION,
  endpoint: INTERNAL_ENDPOINT?.href,
  forcePathStyle: !!INTERNAL_ENDPOINT,
  // AWS SDK ≥ v3.600 defaults requestChecksumCalculation to 'WHEN_SUPPORTED',
  // which injects an x-amz-checksum-crc32 header computed over the *empty*
  // body at presign time.  MinIO then verifies the CRC32 of the actual upload
  // content and rejects it with 403 because the values differ.
  // Setting 'WHEN_REQUIRED' restores the pre-v3.600 behaviour where checksums
  // are omitted unless the service explicitly requires them.
  requestChecksumCalculation: 'WHEN_REQUIRED' as any,
  credentials: s3Credentials,
});

// Presigned GET/PUT URLs only (no TCP at sign time; Host must match nginx → MinIO).
const s3Presign = new S3Client({
  region: REGION,
  endpoint: PRESIGN_SIGNER_ENDPOINT?.href,
  forcePathStyle: !!PRESIGN_SIGNER_ENDPOINT,
  requestChecksumCalculation: 'WHEN_REQUIRED' as any,
  // Keep response validation aligned; avoids env-based defaults overriding presign behavior.
  responseChecksumValidation: 'WHEN_REQUIRED' as any,
  credentials: s3Credentials,
});

// ── Bulk delete ───────────────────────────────────────────────────────────────

/**
 * Delete up to N storage objects best-effort.  Failures are logged but
 * never thrown — the caller (message delete) already committed the DB
 * change; orphaned objects are a storage cost issue, not a correctness one.
 */
async function deleteStorageKeys(keys: string[]) {
  if (!keys.length) return;
  const CHUNK = 1000; // S3 DeleteObjects limit per request
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    try {
      const cmd = new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      });
      await s3.send(cmd);
    } catch (err) {
      logger.warn({ err, keyCount: chunk.length }, 's3: failed to delete storage objects');
    }
  }
}

module.exports = {
  s3,
  s3Presign,
  BUCKET,
  toClientFacingUrl,
  assertDirectPresignedUrlMatchesSigner,
  deleteStorageKeys,
};
