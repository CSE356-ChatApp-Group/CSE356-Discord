#!/usr/bin/env node
/**
 * Steady sustained POST /messages to one hot channel (no ramp).
 * Run on prod VM1 (trusted loopback), same trust pattern as prod-vm-ladder-loadtest.mjs.
 *
 *   INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 \
 *   STEADY_CONCURRENCY=30 STEADY_DURATION_SEC=720 VERIFY=0 \
 *   node scripts/prod-sustained-channel-post.mjs
 */
if (process.env.INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const base = (process.env.BASE_URL || 'https://127.0.0.1/api/v1').replace(/\/$/, '');
const concurrency = Math.min(64, Math.max(1, Number.parseInt(process.env.STEADY_CONCURRENCY || '30', 10)));
const durationSec = Math.min(3600, Math.max(60, Number.parseInt(process.env.STEADY_DURATION_SEC || '720', 10)));
const pw = process.env.SEED_PASSWORD || 'Password1!';

async function j(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const username = `ss${stamp}`.slice(0, 32);
  const email = `ss-${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', {
    email,
    username,
    password: pw,
    displayName: username,
  });
  const token = reg.accessToken;
  const slug = `s${stamp}`.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || `s${stamp}`;
  const comm = await j('POST', '/communities', { slug, name: slug, description: 'sustained' }, token);
  const communityId = comm.community?.id;
  const chan = await j(
    'POST',
    '/channels',
    { communityId, name: `c-${stamp}`.slice(0, 32), isPrivate: false },
    token,
  );
  const channelId = chan.channel?.id;
  return { token, channelId, communityId };
}

async function onePost(token, channelId, runId, i) {
  const url = `${base}/messages`;
  const body = JSON.stringify({
    channelId,
    content: `steady-${runId}-${i}-${Math.random().toString(36).slice(2, 12)}`,
  });
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `steady-${runId}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    },
    body,
  });
  const ms = performance.now() - t0;
  return { status: res.status, ms };
}

async function worker(token, channelId, runId, runUntilMs, out) {
  let i = 0;
  while (Date.now() < runUntilMs) {
    i += 1;
    out.push(await onePost(token, channelId, runId, i));
  }
}

async function main() {
  console.error(`[sustained] seeding concurrency=${concurrency} duration=${durationSec}s on ${base}`);
  const { token, channelId } = await seed();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wallStart = Date.now();
  const runUntilMs = wallStart + durationSec * 1000;
  const bufs = Array.from({ length: concurrency }, () => []);
  await Promise.all(bufs.map((b) => worker(token, channelId, runId, runUntilMs, b)));
  const wallMs = Date.now() - wallStart;
  const all = bufs.flat();
  const hist = Object.create(null);
  let ok = 0;
  for (const x of all) {
    hist[x.status] = (hist[x.status] || 0) + 1;
    if (x.status === 201) ok += 1;
  }
  const lat = all.map((x) => x.ms).sort((a, b) => a - b);
  const p99 = lat.length ? lat[Math.ceil(0.99 * lat.length) - 1] : 0;
  console.log(
    JSON.stringify({
      sustained_summary: true,
      concurrency,
      duration_sec: durationSec,
      wall_ms: wallMs,
      total: all.length,
      ok_201: ok,
      status_histogram: hist,
      msgs_per_sec: Math.round((ok / (wallMs / 1000)) * 1000) / 1000,
      client_latency_p99_ms: Math.round(p99 * 10) / 10,
    }),
  );
}

main().catch((e) => {
  console.error(e.message, e.body || '');
  process.exit(1);
});
