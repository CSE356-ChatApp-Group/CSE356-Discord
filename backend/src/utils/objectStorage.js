'use strict';

const { URL } = require('url');
const { S3Client } = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BUCKET || 'chatapp-attachments';
const REGION = process.env.S3_REGION || 'us-east-1';

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
  const normalizedSuffix = suffix && suffix !== '/'
    ? (suffix.startsWith('/') ? suffix : `/${suffix}`)
    : '';
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
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  } : undefined,
});

module.exports = {
  BUCKET,
  REGION,
  PUBLIC_ENDPOINT,
  INTERNAL_ENDPOINT,
  normalizeEndpoint,
  parseEndpoint,
  resolveInternalEndpoint,
  toClientFacingUrl,
  s3,
};
