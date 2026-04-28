#!/usr/bin/env node
/**
 * Sustained hot-channel POST burst: N concurrent workers loop for wall-clock duration.
 * Use to stress per-channel Redis insert lock + Postgres after write-path optimizations.
 *
 * From repo root:
 *   BASE_URL=https://api.example.com/api/v1 \
 *   TOKEN=eyJ... \
 *   CHANNEL_ID=<uuid> \
 *   CONCURRENCY=8 \
 *   DURATION_SEC=45 \
 *   node backend/scripts/bench-channel-hot-sustained.mjs
 *
 * Outputs JSON: client-side latency p50/p95/p99, status histogram, msgs/sec (201 only),
 * total requests, 503 count. Correlate with Prometheus (see scripts/hot-channel-convoy-validate.sh).
 */
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '');
const token = process.env.TOKEN || '';
const channelId = process.env.CHANNEL_ID || '';
const concurrency = Math.min(64, Math.max(1, Number.parseInt(process.env.CONCURRENCY || '8', 10)));
const durationSec = Math.min(600, Math.max(5, Number.parseInt(process.env.DURATION_SEC || '45', 10)));

if (!token || !channelId) {
  console.error('Set TOKEN and CHANNEL_ID (JWT + channel UUID).');
  process.exit(1);
}

const url = `${baseUrl}/messages`;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let seq = 0;

function nextKey() {
  seq += 1;
  return `hotsust-${runId}-${seq}`;
}

async function one() {
  const idemKey = nextKey();
  const body = JSON.stringify({
    channelId,
    content: `hot-${runId}-${Math.random().toString(36).slice(2, 14)}`,
  });
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    body,
  });
  const ms = performance.now() - t0;
  return { status: res.status, ms };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

async function worker(runUntilMs, out) {
  const latencies = [];
  const statusCounts = Object.create(null);
  while (Date.now() < runUntilMs) {
    const { status, ms } = await one();
    latencies.push(ms);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  out.push({ latencies, statusCounts });
}

async function main() {
  const wallStart = Date.now();
  const runUntilMs = wallStart + durationSec * 1000;
  const buckets = [];
  await Promise.all(
    Array.from({ length: concurrency }, () => worker(runUntilMs, buckets)),
  );
  const wallMs = Date.now() - wallStart;

  const allMs = [];
  const statusCounts = Object.create(null);
  for (const b of buckets) {
    allMs.push(...b.latencies);
    for (const [k, v] of Object.entries(b.statusCounts)) {
      statusCounts[k] = (statusCounts[k] || 0) + v;
    }
  }
  allMs.sort((a, b) => a - b);
  const n = allMs.length;
  const ok = statusCounts[201] || 0;
  const s503 = statusCounts[503] || 0;
  const throughput = ok / (wallMs / 1000);

  console.log(
    JSON.stringify(
      {
        wall_duration_ms: wallMs,
        concurrency,
        duration_sec_target: durationSec,
        total_requests: n,
        ok_201: ok,
        status_503: s503,
        status_histogram: statusCounts,
        client_latency_ms: {
          p50: Math.round(percentile(allMs, 50) * 10) / 10,
          p95: Math.round(percentile(allMs, 95) * 10) / 10,
          p99: Math.round(percentile(allMs, 99) * 10) / 10,
        },
        throughput_201_per_sec: Math.round(throughput * 100) / 100,
        requests_per_sec: Math.round((n / (wallMs / 1000)) * 100) / 100,
        gradingNote:
          'Correlate client_latency with Prometheus message_channel_insert_lock_wait_ms and http_server_request_duration_ms for POST /api/v1/messages/; 503 may be insert_lock_timeout or pool.',
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
