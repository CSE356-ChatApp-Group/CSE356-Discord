#!/usr/bin/env node
/**
 * Ladder load: one hot channel, ramp concurrent POST workers 5 → 10 → 20 → 40, 60s each.
 *
 * Run ON an app VM (e.g. VM1) so client IP is loopback / RFC1918 — skips in-memory message
 * limits, community-join limits, and AUTO_IP_BAN strikes (trustedClientIp + autoIpBan).
 *
 * Direct one worker:
 *   BASE_URL=http://127.0.0.1:4000/api/v1 node scripts/load/prod-vm-ladder-loadtest.mjs
 *
 * Full fleet via nginx (VM only; INSECURE_TLS for cert/host mismatch on 127.0.0.1):
 *   INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 node scripts/load/prod-vm-ladder-loadtest.mjs
 *
 * VERIFY reads: with nginx loopback you must use a worker URL (not nginx) for GET /messages
 * (raceChannelAccess / cache). Example:
 *   VERIFY_READ_BASE_URL=http://127.0.0.1:4000/api/v1
 *
 * Optional VERIFY=0 to skip post-run history / last_message checks.
 */
if (process.env.INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const base = (process.env.BASE_URL || 'http://127.0.0.1:4000/api/v1').replace(/\/$/, '');
/** Reads for VERIFY: nginx loopback returns 403 on GET /messages — use VM worker (port 4000). */
const readBase = (
  process.env.VERIFY_READ_BASE_URL ||
  (base.startsWith('https://127.0.0.1/') ? 'http://127.0.0.1:4000/api/v1' : base)
).replace(/\/$/, '');
const levels = (process.env.LADDER_LEVELS || '5,10,20,40')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => n > 0);
const sustainSec = Math.min(600, Math.max(10, Number.parseInt(process.env.SUSTAIN_SEC || '60', 10)));
const pw = process.env.SEED_PASSWORD || 'Password1!';
const doVerify = process.env.VERIFY !== '0';

if (doVerify && base.startsWith('https://127.0.0.1/') && readBase === base) {
  console.error(
    '[ladder] VERIFY requires VERIFY_READ_BASE_URL=http://127.0.0.1:4000/api/v1 (or unset to use default worker read path)',
  );
  process.exit(1);
}

/** @type {{ id: string, created_at: string }[]} */
const postedSuccess = [];

function readConsistencyHeaders(token, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin === readBase) {
    headers['X-ChatApp-Read-Consistency'] = 'primary';
  }
  return headers;
}

async function j(method, path, body, token, origin = base) {
  const headers = readConsistencyHeaders(token, origin);
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const username = `ld${stamp}`.slice(0, 32);
  const email = `ld-${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', {
    email,
    username,
    password: pw,
    displayName: username,
  });
  const token = reg.accessToken;
  const userId = reg.user?.id != null ? String(reg.user.id) : null;
  const slug = `l${stamp}`.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || `l${stamp}`;
  const comm = await j('POST', '/communities', { slug, name: slug, description: 'ladder' }, token);
  const communityId = comm.community?.id;
  const chan = await j(
    'POST',
    '/channels',
    { communityId, name: `c-${stamp}`.slice(0, 32), isPrivate: false },
    token,
  );
  const channelId = chan.channel?.id;
  return { token, channelId, communityId, userId };
}

async function probeVerifyRead(token, channelId) {
  const res = await fetch(
    `${readBase}/messages?channelId=${encodeURIComponent(channelId)}&limit=1`,
    { headers: readConsistencyHeaders(token, readBase) },
  );
  const t = await res.text();
  if (!res.ok) {
    throw new Error(`VERIFY read probe GET /messages -> ${res.status} ${t.slice(0, 200)}`);
  }
}

async function onePost(token, channelId, runId, i) {
  const url = `${base}/messages`;
  const body = JSON.stringify({
    channelId,
    content: `ladder-${runId}-${i}-${Math.random().toString(36).slice(2, 12)}`,
  });
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `ladder-${runId}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    },
    body,
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (res.status === 201 && data?.message?.id) {
    postedSuccess.push({
      id: String(data.message.id),
      created_at: String(data.message.createdAt || data.message.created_at || ''),
    });
  }
  return { status: res.status, ms };
}

async function worker(token, channelId, runId, runUntilMs, out) {
  let i = 0;
  while (Date.now() < runUntilMs) {
    i += 1;
    out.push(await onePost(token, channelId, runId, i));
  }
}

async function runLevel(concurrency, token, channelId) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wallStart = Date.now();
  const runUntilMs = wallStart + sustainSec * 1000;
  const buckets = Array.from({ length: concurrency }, () => []);
  await Promise.all(
    buckets.map((buf) => worker(token, channelId, runId, runUntilMs, buf)),
  );
  const wallMs = Date.now() - wallStart;
  const all = buckets.flat();
  const lat = all.map((x) => x.ms).sort((a, b) => a - b);
  const hist = Object.create(null);
  for (const { status } of all) {
    hist[status] = (hist[status] || 0) + 1;
  }
  const ok = hist[201] || 0;
  let client_gt_2000_total = 0;
  let client_gt_2000_201 = 0;
  for (const x of all) {
    if (x.ms > 2000) {
      client_gt_2000_total += 1;
      if (x.status === 201) client_gt_2000_201 += 1;
    }
  }
  return {
    concurrency,
    sustain_sec: sustainSec,
    wall_ms: wallMs,
    total: all.length,
    ok_201: ok,
    status_histogram: hist,
    msgs_per_sec: Math.round((ok / (wallMs / 1000)) * 1000) / 1000,
    client_latency_ms: {
      p50: Math.round(percentile(lat, 50) * 10) / 10,
      p95: Math.round(percentile(lat, 95) * 10) / 10,
      p99: Math.round(percentile(lat, 99) * 10) / 10,
    },
    client_latency_gt_2000_ms: {
      count_all_statuses: client_gt_2000_total,
      count_201: client_gt_2000_201,
      frac_of_all_requests: Math.round((client_gt_2000_total / all.length) * 10000) / 10000,
      frac_of_201: ok ? Math.round((client_gt_2000_201 / ok) * 10000) / 10000 : 0,
    },
  };
}

function cmpCreated(a, b) {
  const ta = Date.parse(a.created_at || a.createdAt) || 0;
  const tb = Date.parse(b.created_at || b.createdAt) || 0;
  if (ta !== tb) return ta - tb;
  return String(a.id).localeCompare(String(b.id));
}

async function fetchChannelHistory(token, channelId, maxPages) {
  const byId = new Map();
  let before = null;
  for (let p = 0; p < maxPages; p += 1) {
    const q = before
      ? `channelId=${encodeURIComponent(channelId)}&limit=100&before=${encodeURIComponent(before)}`
      : `channelId=${encodeURIComponent(channelId)}&limit=100`;
    const res = await fetch(`${readBase}/messages?${q}`, {
      headers: readConsistencyHeaders(token, readBase),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`GET /messages -> ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const messages = data.messages || [];
    if (!messages.length) break;
    for (const m of messages) {
      if (m.id) byId.set(String(m.id), m);
    }
    const oldest = messages[0];
    before = String(oldest.id);
    if (messages.length < 100) break;
  }
  return byId;
}

function expectedUnreadFromHistory(sortedRows, lastReadMessageId) {
  if (!lastReadMessageId) return sortedRows.length;
  const idx = sortedRows.findIndex((m) => String(m.id) === String(lastReadMessageId));
  if (idx < 0) return sortedRows.length;
  return sortedRows.length - idx - 1;
}

async function verifyRun(token, communityId, channelId, userId) {
  const ids = postedSuccess.map((x) => x.id);
  let newestPosted = null;
  for (const row of postedSuccess) {
    if (!newestPosted || cmpCreated(newestPosted, row) < 0) newestPosted = row;
  }
  const newestId = newestPosted ? String(newestPosted.id) : null;
  const drainDeadline = Date.now() + 45000;
  let lastCh = null;
  while (Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const chList = await j(
      'GET',
      `/channels?communityId=${encodeURIComponent(communityId)}`,
      null,
      token,
      readBase,
    );
    const channels = chList.channels || [];
    lastCh = Array.isArray(channels) ? channels.find((c) => String(c.id) === String(channelId)) : null;
    const lid = lastCh?.last_message_id != null ? String(lastCh.last_message_id) : null;
    if (newestId && lid === newestId) break;
    if (!newestId && !lid) break;
  }
  const uniquePosted = new Set(ids);
  const noDupAmongPosts = uniquePosted.size === ids.length;

  const minPages = Math.min(
    800,
    Math.max(120, Math.ceil(uniquePosted.size / 100) + 30),
  );
  const byId = await fetchChannelHistory(token, channelId, minPages);
  let missing = 0;
  for (const id of uniquePosted) {
    if (!byId.has(id)) missing += 1;
  }

  const allRows = [...byId.values()].sort(cmpCreated);
  let orderOk = true;
  for (let i = 1; i < allRows.length; i += 1) {
    if (cmpCreated(allRows[i - 1], allRows[i]) > 0) {
      orderOk = false;
      break;
    }
  }

  let lastMessageOk = null;
  let lastMessageDetail = null;
  let unread_ok = null;
  let unread_detail = null;
  try {
    const ch = lastCh;
    if (!ch) throw new Error('channel not in GET /channels');
    if (ch.last_message_id) {
      lastMessageDetail = { channel_last_message_id: ch.last_message_id, newest_posted_id: newestPosted?.id };
      lastMessageOk = newestPosted ? String(ch.last_message_id) === String(newestPosted.id) : null;
    }
    const apiUnread = Number(ch.unread_message_count ?? 0);
    const lastAuthor = ch.last_message_author_id != null ? String(ch.last_message_author_id) : '';
    const sorted = allRows;
    if (userId && lastAuthor === userId) {
      unread_ok = apiUnread === 0;
      unread_detail = { mode: 'last_message_self_author', apiUnread };
    } else if (ids.length === 0) {
      unread_ok = true;
      unread_detail = { mode: 'no_posts' };
    } else {
      const expected = expectedUnreadFromHistory(sorted, ch.my_last_read_message_id);
      const slack = Math.max(5, Math.ceil(sorted.length * 0.02));
      unread_ok = Math.abs(apiUnread - expected) <= slack;
      unread_detail = {
        mode: 'count_vs_history',
        apiUnread,
        expected,
        slack,
        my_last_read_message_id: ch.my_last_read_message_id ?? null,
      };
    }
  } catch (e) {
    lastMessageDetail = { error: e.message };
    unread_ok = false;
    unread_detail = { error: e.message };
  }

  const correctness_ok =
    noDupAmongPosts &&
    missing === 0 &&
    orderOk &&
    lastMessageOk === true &&
    unread_ok === true;

  return {
    posted_201_count: ids.length,
    unique_posted_ids: uniquePosted.size,
    no_duplicate_posted_ids: noDupAmongPosts,
    history_rows_fetched: byId.size,
    posted_ids_missing_from_history: missing,
    global_ordering_strictly_non_decreasing: orderOk,
    last_message_matches_newest_posted: lastMessageOk,
    last_message_detail: lastMessageDetail,
    unread_ok,
    unread_detail,
    correctness_ok,
    verify_read_base: readBase,
  };
}

async function main() {
  console.error(`[ladder] seeding on ${base} ...`);
  const { token, channelId, communityId, userId } = await seed();
  console.error(`[ladder] channel=${channelId} community=${communityId}`);
  if (doVerify) {
    await new Promise((r) => setTimeout(r, 800));
    console.error(`[ladder] verify read base=${readBase} (probe GET /messages) ...`);
    await probeVerifyRead(token, channelId);
  }
  const report = {
    base_url: base,
    verify_read_base: readBase,
    levels,
    sustain_sec: sustainSec,
    phases: [],
  };
  for (const n of levels) {
    console.error(`[ladder] phase concurrency=${n} for ${sustainSec}s ...`);
    const phase = await runLevel(n, token, channelId);
    report.phases.push(phase);
    console.log(JSON.stringify({ phase_marker: true, ...phase }));
  }
  if (doVerify) {
    console.error('[ladder] verifying history / ordering / last_message / unread ...');
    report.verification = await verifyRun(token, communityId, channelId, userId);
    console.log(JSON.stringify({ verification: true, ...report.verification }));
  }
  console.log(JSON.stringify({ summary: true, ...report }));
}

main().catch((e) => {
  console.error(e.message, e.body || e.status || '');
  process.exit(1);
});
