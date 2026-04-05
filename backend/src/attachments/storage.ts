'use strict';

/**
 * Shared S3/MinIO client and helpers used by the attachments router and
 * the message side-effects queue (cleanup on message delete).
 *
 * Extracted here so both consumers share one S3Client instance and so
 * circular-import issues between messages/ and attachments/ are avoided.
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
 * Rewrites an internally-signed URL so that the host/path matches what
 * the client should use.  This is a no-op when PUBLIC and INTERNAL
 * endpoints are the same (real AWS S3) or when neither is configured.
 */
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

// ── S3 client ─────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: REGION,
  endpoint: INTERNAL_ENDPOINT?.href,
  forcePathStyle: !!INTERNAL_ENDPOINT,
  credentials: process.env.S3_ACCESS_KEY ? {
    accessKeyId:     process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  } : undefined, // falls back to IAM role in EC2/ECS
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

module.exports = { s3, BUCKET, toClientFacingUrl, deleteStorageKeys };
