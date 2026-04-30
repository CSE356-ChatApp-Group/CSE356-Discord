#!/usr/bin/env node
/**
 * Multi-channel POST ladder: one user, N channels in one new community, round-robin posts.
 * Run on prod VM1 (same pattern as prod-vm-ladder-loadtest.mjs).
 *
 *   INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 \
 *   CHANNELS=4 CONCURRENCY=32 SUSTAIN_SEC=45 node scripts/load/prod-multi-channel-write-ladder.mjs
 */
if (process.env.INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const base = (process.env.BASE_URL || 'https://127.0.0.1/api/v1').replace(/\/$/, '');
const channels = Math.min(16, Math.max(2, parseInt(process.env.CHANNELS || '4', 10)));
const concurrency = Math.min(64, Math.max(4, parseInt(process.env.CONCURRENCY || '32', 10)));
const sustainSec = Math.min(120, Math.max(15, parseInt(process.env.SUSTAIN_SEC || '45', 10)));
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
  const username = `mc${stamp}`.slice(0, 32);
  const email = `mc-${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', {
    email,
    username,
    password: pw,
    displayName: username,
  });
  const token = reg.accessToken;
  const slug = `m${stamp}`.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || `m${stamp}`;
  const comm = await j('POST', '/communities', { slug, name: slug, description: 'multi-ladder' }, token);
  const communityId = comm.community?.id;
  const channelIds = [];
  for (let i = 0; i < channels; i += 1) {
    const chan = await j(
      'POST',
      '/channels',
      { communityId, name: `c${i}-${stamp}`.slice(0, 32), isPrivate: false },
      token,
    );
    channelIds.push(String(chan.channel?.id));
  }
  return { token, channelIds, communityId };
}

async function worker(token, channelIds, runUntilMs, out) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;
  while (Date.now() < runUntilMs) {
    const channelId = channelIds[seq % channelIds.length];
    seq += 1;
    const body = JSON.stringify({
      channelId,
      content: `mcladder-${runId}-${seq}-${Math.random().toString(36).slice(2, 10)}`,
    });
    const t0 = performance.now();
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `mc-${runId}-${seq}`,
      },
      body,
    });
    const ms = performance.now() - t0;
    out.push({ status: res.status, ms });
  }
}

async function main() {
  console.error(`[multi-ladder] seeding ${channels} channels on ${base} ...`);
  const { token, channelIds } = await seed();
  console.error(`[multi-ladder] concurrency=${concurrency} sustain=${sustainSec}s channels=${channelIds.length}`);
  const wallStart = Date.now();
  const runUntilMs = wallStart + sustainSec * 1000;
  const bufs = Array.from({ length: concurrency }, () => []);
  await Promise.all(bufs.map((b) => worker(token, channelIds, runUntilMs, b)));
  const wallMs = Date.now() - wallStart;
  const all = bufs.flat();
  const hist = Object.create(null);
  let ok = 0;
  for (const x of all) {
    hist[x.status] = (hist[x.status] || 0) + 1;
    if (x.status === 201) ok += 1;
  }
  const lat = all.map((x) => x.ms).sort((a, b) => a - b);
  const p99i = Math.ceil(0.99 * lat.length) - 1;
  console.log(
    JSON.stringify(
      {
        summary: true,
        channels,
        concurrency,
        sustain_sec: sustainSec,
        wall_ms: wallMs,
        total: all.length,
        ok_201: ok,
        status_histogram: hist,
        msgs_per_sec: Math.round((ok / (wallMs / 1000)) * 1000) / 1000,
        client_latency_ms: {
          p99: lat.length ? Math.round(lat[Math.max(0, p99i)] * 10) / 10 : 0,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e.message, e.body || '');
  process.exit(1);
});
