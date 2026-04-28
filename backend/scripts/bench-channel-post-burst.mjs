#!/usr/bin/env node
/**
 * Burst POST /api/v1/messages to one channel (same Idempotency-Key prefix per request).
 *
 * Usage (after obtaining a JWT and channel UUID):
 *   BASE_URL=http://127.0.0.1:3000/api/v1 \
 *   TOKEN=... \
 *   CHANNEL_ID=... \
 *   CONCURRENCY=32 TOTAL=200 \
 *   node scripts/bench-channel-post-burst.mjs
 *
 * Compare two server configs by restarting with:
 *   MESSAGE_INSERT_LOCK_MODE=serialized  (default)
 *   MESSAGE_INSERT_LOCK_MODE=optimistic
 *
 * Prints: duration_ms, ok count, non-201 count, status histogram, req/s.
 */
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '');
const token = process.env.TOKEN || '';
const channelId = process.env.CHANNEL_ID || '';
const concurrency = Math.max(1, Number.parseInt(process.env.CONCURRENCY || '16', 10));
const total = Math.max(1, Number.parseInt(process.env.TOTAL || '100', 10));

if (!token || !channelId) {
  console.error('Set TOKEN and CHANNEL_ID (JWT + channel UUID).');
  process.exit(1);
}

const url = `${baseUrl}/messages`;
let next = 0;

async function one(i) {
  const body = JSON.stringify({
    channelId,
    content: `bench-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `bench-${i}-${Math.random().toString(36).slice(2)}`,
    },
    body,
  });
  return res.status;
}

async function worker(statusCounts) {
  for (;;) {
    const i = next;
    next += 1;
    if (i >= total) return;
    const st = await one(i);
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }
}

async function main() {
  const statusCounts = Object.create(null);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker(statusCounts)));
  const ms = Date.now() - t0;
  const ok = statusCounts[201] || 0;
  const non201 = total - ok;
  console.log(
    JSON.stringify(
      {
        duration_ms: ms,
        concurrency,
        total,
        ok_201: ok,
        non_201: non201,
        req_per_s: (total / (ms / 1000)).toFixed(1),
        status_histogram: statusCounts,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
