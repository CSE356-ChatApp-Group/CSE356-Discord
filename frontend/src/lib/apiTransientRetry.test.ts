import { describe, expect, it } from 'vitest';
import {
  allowsTransientRetry,
  isTransientRetryStatus,
  nextTransientWaitMs,
  parseRetryAfterMs,
} from './apiTransientRetry';

describe('parseRetryAfterMs', () => {
  it('parses delay-seconds form', () => {
    const res = new Response(null, { headers: { 'Retry-After': '3' } });
    expect(parseRetryAfterMs(res)).toBe(3000);
  });

  it('caps large second values', () => {
    const res = new Response(null, { headers: { 'Retry-After': '9999' } });
    expect(parseRetryAfterMs(res)).toBe(60_000);
  });

  it('parses HTTP-date form when in the future', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const res = new Response(null, { headers: { 'Retry-After': future } });
    const ms = parseRetryAfterMs(res);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(1000);
    expect(ms!).toBeLessThanOrEqual(60_000);
  });
});

describe('nextTransientWaitMs', () => {
  it('uses the larger of Retry-After and exponential floor', () => {
    const res = new Response(null, { headers: { 'Retry-After': '2' } });
    expect(nextTransientWaitMs(0, res)).toBe(2000);
  });

  it('uses exponential when Retry-After is absent', () => {
    const res = new Response(null);
    expect(nextTransientWaitMs(0, res)).toBe(200);
    expect(nextTransientWaitMs(2, res)).toBe(800);
  });
});

describe('allowsTransientRetry', () => {
  it('allows GET everywhere', () => {
    expect(allowsTransientRetry('GET', '/messages')).toBe(true);
    expect(allowsTransientRetry('GET', '/communities')).toBe(true);
  });

  it('allows POST /messages only when an idempotency key is present', () => {
    expect(allowsTransientRetry('POST', '/messages', 'a-real-key')).toBe(true);
    expect(allowsTransientRetry('POST', '/messages', '')).toBe(false);
    expect(allowsTransientRetry('POST', '/messages', null)).toBe(false);
    expect(allowsTransientRetry('POST', '/messages')).toBe(false);
    expect(allowsTransientRetry('POST', '/attachments/presign')).toBe(false);
  });

  it('disallows mutating methods without explicit policy', () => {
    expect(allowsTransientRetry('PATCH', '/messages/x')).toBe(false);
    expect(allowsTransientRetry('DELETE', '/messages/x')).toBe(false);
  });
});

describe('isTransientRetryStatus', () => {
  it('matches 503 and 429 only', () => {
    expect(isTransientRetryStatus(503)).toBe(true);
    expect(isTransientRetryStatus(429)).toBe(true);
    expect(isTransientRetryStatus(502)).toBe(false);
    expect(isTransientRetryStatus(500)).toBe(false);
  });
});
