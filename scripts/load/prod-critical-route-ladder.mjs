#!/usr/bin/env node
/**
 * Prod loopback ladder for routes that previously showed high tail latency:
 *
 *   POST /api/v1/communities/:id/join
 *   POST /api/v1/conversations/
 *
 * Run this on VM1 (or another app host) so the client is loopback/RFC1918 and
 * nginx/app external rate limits do not dominate the result.
 *
 * Examples:
 *   INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 \
 *     MODE=join LADDER_LEVELS=5,10,20,40 SUSTAIN_SEC=20 \
 *     node scripts/load/prod-critical-route-ladder.mjs
 *
 *   INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 \
 *     MODE=conversation CONVERSATION_TARGETS=800 LADDER_LEVELS=5,10,20,40 \
 *     node scripts/load/prod-critical-route-ladder.mjs
 *
 * Notes:
 * - Setup work (registering users, creating the community/channels) is done
 *   before timed phases and is reported separately.
 * - `conversation` mode uses one creator account and many fresh target users;
 *   each measured request consumes a target user to exercise the creation path
 *   instead of the existing-DM cache fast path.
 * - `join` mode creates one public community and consumes fresh user tokens;
 *   `PREFILL_MEMBERS` can make the deferred join fanout resemble a large
 *   community without counting that prefill in the measured phase.
 */

if (process.env.INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const base = (process.env.BASE_URL || 'https://127.0.0.1/api/v1').replace(/\/$/, '');
const mode = String(process.env.MODE || 'both').toLowerCase();
const levels = (process.env.LADDER_LEVELS || '5,10,20,40')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => n > 0);
const sustainSec = clampInt(process.env.SUSTAIN_SEC, 10, 600, 30);
const setupConcurrency = clampInt(process.env.SETUP_CONCURRENCY, 1, 64, 12);
const password = process.env.SEED_PASSWORD || 'Password1!';
const joinUsers = clampInt(process.env.JOIN_USERS, 1, 50000, defaultNeededUsers(1.5));
const prefillMembers = clampInt(process.env.PREFILL_MEMBERS, 0, 50000, 0);
const joinChannels = clampInt(process.env.JOIN_CHANNELS, 0, 64, 4);
const conversationTargets = clampInt(
  process.env.CONVERSATION_TARGETS,
  1,
  50000,
  defaultNeededUsers(1.5),
);
const conversationGroupSize = clampInt(process.env.CONVERSATION_GROUP_SIZE, 1, 16, 1);

if (!['join', 'conversation', 'both'].includes(mode)) {
  console.error(`MODE must be join, conversation, or both; got ${mode}`);
  process.exit(1);
}
if (levels.length === 0) {
  console.error('LADDER_LEVELS produced no positive concurrency levels');
  process.exit(1);
}

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function defaultNeededUsers(multiplier) {
  const maxLevel = levels.length ? Math.max(...levels) : 40;
  return Math.ceil(maxLevel * sustainSec * multiplier);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function summarizeRequests({ label, concurrency, wallMs, rows, consumed, available }) {
  const lat = rows.map((x) => x.ms).sort((a, b) => a - b);
  const statusHistogram = {};
  let gt2000 = 0;
  for (const row of rows) {
    statusHistogram[row.status] = (statusHistogram[row.status] || 0) + 1;
    if (row.ms > 2000) gt2000 += 1;
  }
  const ok2xx = rows.filter((x) => x.status >= 200 && x.status < 300).length;
  const total = rows.length;
  return {
    phase_marker: true,
    label,
    concurrency,
    sustain_sec: sustainSec,
    wall_ms: wallMs,
    total,
    ok_2xx: ok2xx,
    status_histogram: statusHistogram,
    route_requests_per_sec: round3(ok2xx / Math.max(wallMs / 1000, 0.001)),
    client_latency_ms: {
      p50: round1(percentile(lat, 50)),
      p95: round1(percentile(lat, 95)),
      p99: round1(percentile(lat, 99)),
      max: round1(lat[lat.length - 1] || 0),
    },
    client_latency_gt_2000_ms: {
      count_all_statuses: gt2000,
      frac_of_all_requests: total ? round4(gt2000 / total) : 0,
    },
    work_items: { consumed, available },
  };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function round4(n) { return Math.round(n * 10000) / 10000; }

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
    data = { _raw: text.slice(0, 240) };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function timedRequest(method, path, body, token) {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - t0;
  await res.arrayBuffer().catch(() => {});
  return { status: res.status, ms };
}

async function registerUser(prefix) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const username = `${prefix}${stamp}`.replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  const reg = await j('POST', '/auth/register', {
    email: `${username}@example.com`,
    username,
    password,
    displayName: username,
  });
  return {
    token: reg.accessToken,
    id: String(reg.user?.id || ''),
    username,
  };
}

async function parallelMapCount(count, worker, label) {
  const out = new Array(count);
  let next = 0;
  const startedAt = Date.now();
  const workers = Array.from({ length: Math.min(setupConcurrency, count) }, async () => {
    while (next < count) {
      const i = next++;
      out[i] = await worker(i);
      if ((i + 1) % 250 === 0) {
        console.error(`[setup:${label}] ${i + 1}/${count}`);
      }
    }
  });
  await Promise.all(workers);
  return { items: out, wall_ms: Date.now() - startedAt };
}

async function seedJoinScenario() {
  const owner = await registerUser('cjown');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const slug = `cj-${stamp}`.replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  const comm = await j('POST', '/communities', {
    slug,
    name: slug,
    description: 'critical join ladder',
  }, owner.token);
  const communityId = String(comm.community?.id || comm.id || '');
  if (!communityId) throw new Error('community create response did not include id');

  for (let i = 0; i < joinChannels; i += 1) {
    await j('POST', '/channels', {
      communityId,
      name: `cj-${i}-${stamp}`.slice(0, 32),
      isPrivate: false,
    }, owner.token);
  }

  let prefill = { items: [], wall_ms: 0 };
  if (prefillMembers > 0) {
    prefill = await parallelMapCount(prefillMembers, async (i) => {
      const user = await registerUser('cjpre');
      await j('POST', `/communities/${communityId}/join`, null, user.token);
      return user;
    }, 'join-prefill');
  }

  const joiners = await parallelMapCount(joinUsers, (i) => registerUser('cjusr'), 'join-users');
  return {
    label: 'join',
    communityId,
    owner,
    users: joiners.items,
    setup: {
      community_id: communityId,
      channels: joinChannels,
      join_users: joinUsers,
      join_user_setup_ms: joiners.wall_ms,
      prefill_members: prefillMembers,
      prefill_setup_ms: prefill.wall_ms,
    },
  };
}

async function seedConversationScenario() {
  const creator = await registerUser('cvown');
  const targetCount = Math.max(conversationTargets, conversationGroupSize);
  const targets = await parallelMapCount(targetCount, (i) => registerUser('cvusr'), 'conversation-targets');
  return {
    label: 'conversation',
    creator,
    targets: targets.items,
    setup: {
      targets: targetCount,
      target_setup_ms: targets.wall_ms,
      group_size: conversationGroupSize,
    },
  };
}

async function runJoinLevel(scenario, concurrency, cursor) {
  const wallStart = Date.now();
  const runUntilMs = wallStart + sustainSec * 1000;
  const rows = [];
  let nextUser = cursor.value;
  async function worker() {
    while (Date.now() < runUntilMs && nextUser < scenario.users.length) {
      const user = scenario.users[nextUser++];
      rows.push(await timedRequest('POST', `/communities/${scenario.communityId}/join`, null, user.token));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const consumed = nextUser - cursor.value;
  cursor.value = nextUser;
  return summarizeRequests({
    label: 'community_join',
    concurrency,
    wallMs: Date.now() - wallStart,
    rows,
    consumed,
    available: scenario.users.length,
  });
}

async function runConversationLevel(scenario, concurrency, cursor) {
  const wallStart = Date.now();
  const runUntilMs = wallStart + sustainSec * 1000;
  const rows = [];
  let nextTarget = cursor.value;
  async function worker() {
    while (
      Date.now() < runUntilMs
      && nextTarget + conversationGroupSize <= scenario.targets.length
    ) {
      const participantIds = scenario.targets
        .slice(nextTarget, nextTarget + conversationGroupSize)
        .map((user) => user.id);
      nextTarget += conversationGroupSize;
      rows.push(await timedRequest('POST', '/conversations', { participantIds }, scenario.creator.token));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const consumed = nextTarget - cursor.value;
  cursor.value = nextTarget;
  return summarizeRequests({
    label: conversationGroupSize > 1 ? 'group_conversation_create' : 'dm_conversation_create',
    concurrency,
    wallMs: Date.now() - wallStart,
    rows,
    consumed,
    available: scenario.targets.length,
  });
}

async function runScenario(name, seedFn, runLevelFn) {
  console.error(`[critical-ladder] seeding ${name} scenario on ${base} ...`);
  const scenario = await seedFn();
  console.log(JSON.stringify({ setup: true, scenario: name, ...scenario.setup }));

  const cursor = { value: 0 };
  const phases = [];
  for (const concurrency of levels) {
    console.error(`[critical-ladder] ${name} concurrency=${concurrency} for ${sustainSec}s ...`);
    const phase = await runLevelFn(scenario, concurrency, cursor);
    phases.push(phase);
    console.log(JSON.stringify(phase));
    if (phase.total === 0) {
      console.error(`[critical-ladder] ${name} exhausted seeded work items; stopping scenario`);
      break;
    }
  }
  const summary = { summary: true, scenario: name, base_url: base, levels, sustain_sec: sustainSec, phases };
  console.log(JSON.stringify(summary));
  return summary;
}

async function main() {
  console.error(
    `[critical-ladder] mode=${mode} levels=${levels.join(',')} sustain=${sustainSec}s setupConcurrency=${setupConcurrency}`,
  );
  const summaries = [];
  if (mode === 'join' || mode === 'both') {
    summaries.push(await runScenario('community_join', seedJoinScenario, runJoinLevel));
  }
  if (mode === 'conversation' || mode === 'both') {
    summaries.push(await runScenario('conversation_create', seedConversationScenario, runConversationLevel));
  }
  console.log(JSON.stringify({ final_summary: true, summaries }));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  if (err.body) console.error(JSON.stringify(err.body));
  process.exit(1);
});
