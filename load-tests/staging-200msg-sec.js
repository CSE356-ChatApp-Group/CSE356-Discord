/**
 * staging-200msg-sec.js — Dedicated POST /messages capacity benchmark.
 *
 * Measures true app throughput, NOT rate-limit/abuse policy.
 * Requires staging nginx + app bypasses (see deploy/nginx/staging.conf,
 * deploy/nginx/admission-control.conf, deploy/env/staging.required.env).
 *
 * Profiles:
 *   smoke   — 10 msg/s × 1 min, validates bypass works (429/403 ≈ 0)
 *   benchmark — 200 msg/s × 10 min, full capacity measurement
 *   ramp    — staircase 50→100→150→200→250→300 to find the cliff
 *
 * Key design decisions:
 *   - Multiple sender accounts (NUM_SENDERS, default 40) spread across distinct
 *     users so per-user Redis rate limits (if accidentally re-enabled) don't bind.
 *   - Multiple channels (NUM_CHANNELS, default 5) avoid single-row DB hotspots.
 *   - WS listeners (wsVUs) subscribe to channels for delivery measurement.
 *   - Read receipts: OFF by default (LOADTEST_ENABLE_READ_RECEIPTS=1 to enable).
 *   - Reconnect churn: OFF by default (separate scenario).
 *
 * Metrics reported:
 *   message_post_duration — p50/p95/p99 POST latency
 *   message_post_201_total — successful inserts
 *   message_post_fail_total — 4xx + 5xx + timeouts
 *   http_res_status_4xx_total / 5xx — should be ≈0 after bypass
 *   ws_delivery_after_post_ms — realtime delivery latency (WS probe)
 *   ws_delivery_miss_total — WS deliveries > 15s or lost
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

// ── Custom metrics ──────────────────────────────────────────────────────────
const messagePostDuration = new Trend('message_post_duration', true);
const messagePost201Total = new Counter('message_post_201_total');
const messagePostFailTotal = new Counter('message_post_fail_total');
const httpResStatus0 = new Counter('http_res_status_0_total');
const httpResStatus4xx = new Counter('http_res_status_4xx_total');
const httpResStatus5xx = new Counter('http_res_status_5xx_other_total');
const checksRate = new Rate('capacity_checks');
const wsConnectRate = new Rate('ws_connect_success');
const wsDeliveryMs = new Trend('ws_delivery_after_post_ms', true);
const wsDeliveryMissTotal = new Counter('ws_delivery_miss_total');

// ── Configuration ───────────────────────────────────────────────────────────
const BASE_URL = (__ENV.BASE_URL || 'http://136.114.103.71/api/v1').replace(/\/$/, '');
const WS_URL = (__ENV.WS_URL || BASE_URL.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/ws')).replace(/\/$/, '');
const RUN_ID = __ENV.RUN_ID || `msgcap-${Date.now()}`;
const PASSWORD = __ENV.LOADTEST_PASSWORD || 'LoadTest!12345';
const MESSAGE_SIZE = Number(__ENV.MESSAGE_SIZE || 96);
const NUM_SENDERS = Number(__ENV.NUM_SENDERS || 40);
const NUM_CHANNELS = Number(__ENV.NUM_CHANNELS || 5);
const ENABLE_READ_RECEIPTS = __ENV.LOADTEST_ENABLE_READ_RECEIPTS === '1';
const WS_DELIVERY_PROBE = __ENV.LOADTEST_WS_MESSAGE_DELIVERY_PROBE === '1';

// ── Profiles ────────────────────────────────────────────────────────────────
const PROFILES = {
  smoke: {
    constantRate: 10,
    constantDuration: '1m',
    preAllocatedVUs: 20,
    maxVUs: 80,
    wsVUs: 5,
    wsDuration: '1m30s',
    maxFailureRate: 0.05,
    httpP95Ms: 1000,
  },
  benchmark: {
    constantRate: 200,
    constantDuration: '10m',
    preAllocatedVUs: 300,
    maxVUs: 800,
    wsVUs: 40,
    wsDuration: '10m30s',
    maxFailureRate: 0.02,
    httpP95Ms: 500,
  },
  ramp: {
    stages: [
      { target: 50,  duration: '2m' },
      { target: 100, duration: '2m' },
      { target: 150, duration: '2m' },
      { target: 200, duration: '2m' },
      { target: 250, duration: '2m' },
      { target: 300, duration: '2m' },
      { target: 0,   duration: '30s' },
    ],
    preAllocatedVUs: 400,
    maxVUs: 1200,
    wsVUs: 40,
    wsDuration: '11m',
    maxFailureRate: 0.30,
    httpP95Ms: 5000,
  },
};

const profileName = __ENV.LOAD_PROFILE || 'smoke';
const profile = PROFILES[profileName] || PROFILES.smoke;
const useConstantArrival = !profile.stages;

// ── Thresholds ──────────────────────────────────────────────────────────────
const thresholds = {
  message_post_duration: [`p(95)<${profile.httpP95Ms}`],
  capacity_checks: ['rate>0.95'],
  ws_connect_success: ['rate>0.90'],
  http_res_status_4xx_total: [],
  http_res_status_5xx_other_total: [],
};

// ── Scenarios ───────────────────────────────────────────────────────────────
const httpScenario = useConstantArrival
  ? {
      executor: 'constant-arrival-rate',
      exec: 'postMessage',
      rate: profile.constantRate,
      timeUnit: '1s',
      duration: profile.constantDuration,
      preAllocatedVUs: profile.preAllocatedVUs,
      maxVUs: profile.maxVUs,
      gracefulStop: '30s',
    }
  : {
      executor: 'ramping-arrival-rate',
      exec: 'postMessage',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: profile.preAllocatedVUs,
      maxVUs: profile.maxVUs,
      stages: profile.stages,
      gracefulStop: '30s',
    };

const scenarios = {
  message_post: httpScenario,
  ws_listeners: {
    executor: 'constant-vus',
    exec: 'wsListener',
    vus: profile.wsVUs,
    duration: profile.wsDuration,
    gracefulStop: '10s',
  },
};

if (WS_DELIVERY_PROBE) {
  scenarios.ws_delivery_probe = {
    executor: 'constant-vus',
    exec: 'wsDeliveryProbe',
    vus: 1,
    duration: profile.constantDuration || profile.wsDuration || '2m',
    gracefulStop: '25s',
  };
}

export const options = {
  thresholds,
  scenarios,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function baseParams(token, tags) {
  // k6's transpiler rejects object spread in literals; Object.assign is supported.
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    token ? { Authorization: `Bearer ${token}` } : {},
  );
  return Object.assign({ headers: headers, tags: tags || {}, timeout: '30s' });
}

function parseDurationMs(s) {
  // Parse k6-style duration strings like '1m30s', '10m30s', '2m' to milliseconds.
  let ms = 0;
  const m = s.match(/(\d+)m/);
  const sec = s.match(/(\d+)s/);
  if (m) ms += parseInt(m[1]) * 60000;
  if (sec) ms += parseInt(sec[1]) * 1000;
  return ms || 90000;
}

function safeJson(res) {
  try { return res.json(); } catch (_) { return null; }
}

function uniqueUser(label) {
  const slug = `${RUN_ID}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 28);
  return {
    username: `mc-${slug}`.slice(0, 30),
    email: `mc-${slug}@example.com`,
    password: PASSWORD,
  };
}

function registerOrLogin(label) {
  const creds = uniqueUser(label);
  const regRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify(creds),
    baseParams(null, { endpoint: 'auth_register' }),
  );
  if (regRes.status !== 201 && regRes.status !== 409) {
    throw new Error(`register failed for ${label}: ${regRes.status} ${regRes.body}`);
  }
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: creds.username, password: creds.password }),
    baseParams(null, { endpoint: 'auth_login' }),
  );
  const body = safeJson(loginRes);
  if (!body || !body.accessToken) {
    throw new Error(`login failed for ${label}: ${loginRes.status} ${loginRes.body}`);
  }
  return { token: body.accessToken, userId: body.user.id, creds };
}

function batchCreateUsers(credsList) {
  const regResponses = http.batch(
    credsList.map((c) => ({
      method: 'POST',
      url: `${BASE_URL}/auth/register`,
      body: JSON.stringify(c),
      params: baseParams(null, { endpoint: 'auth_register' }),
    })),
  );
  const loginResponses = http.batch(
    credsList.map((c) => ({
      method: 'POST',
      url: `${BASE_URL}/auth/login`,
      body: JSON.stringify({ email: c.username, password: c.password }),
      params: baseParams(null, { endpoint: 'auth_login' }),
    })),
  );
  return loginResponses.map((res, i) => {
    const body = safeJson(res);
    if (!body || !body.accessToken) {
      throw new Error(`batch login failed for ${credsList[i].username}: ${res.status}`);
    }
    return { token: body.accessToken, userId: body.user.id, username: credsList[i].username };
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────
export function setup() {
  console.error(`[setup] Creating ${NUM_SENDERS} senders, ${NUM_CHANNELS} channels, ${profile.wsVUs} WS users`);

  // Create sender accounts
  const senderCreds = Array.from({ length: NUM_SENDERS }, (_, i) => uniqueUser(`sender-${i}`));
  const senders = batchCreateUsers(senderCreds);

  // Create WS listener accounts
  const wsCreds = Array.from({ length: profile.wsVUs }, (_, i) => uniqueUser(`ws-${i}`));
  const wsUsers = batchCreateUsers(wsCreds);

  // Owner creates community
  const owner = senders[0];
  const communitySlug = `mc-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  const commRes = http.post(
    `${BASE_URL}/communities`,
    JSON.stringify({ slug: communitySlug, name: `MsgCap ${RUN_ID}`.slice(0, 80), description: 'capacity benchmark' }),
    baseParams(owner.token, { endpoint: 'communities_create' }),
  );
  if (commRes.status !== 201) {
    throw new Error(`community create failed: ${commRes.status} ${commRes.body}`);
  }
  const communityId = safeJson(commRes).community.id;

  // Join all senders + WS users to community
  const allTokens = [...senders.map((s) => s.token), ...wsUsers.map((w) => w.token)];
  // Batch in chunks of 20 to avoid nginx limits on batch register
  for (let i = 0; i < allTokens.length; i += 20) {
    const chunk = allTokens.slice(i, i + 20);
    http.batch(
      chunk.map((token) => ({
        method: 'POST',
        url: `${BASE_URL}/communities/${communityId}/join`,
        body: JSON.stringify({}),
        params: baseParams(token, { endpoint: 'communities_join' }),
      })),
    );
  }

  // Create channels
  const channels = [];
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const chName = `mc-${RUN_ID}-ch${i}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 28);
    const chRes = http.post(
      `${BASE_URL}/channels`,
      JSON.stringify({ communityId, name: chName, isPrivate: false, description: `capacity channel ${i}` }),
      baseParams(owner.token, { endpoint: 'channels_create' }),
    );
    if (chRes.status !== 201) {
      throw new Error(`channel ${i} create failed: ${chRes.status} ${chRes.body}`);
    }
    channels.push(safeJson(chRes).channel.id);
  }

  console.error(`[setup] Ready: community=${communityId} channels=${channels.length} senders=${senders.length}`);

  return {
    senders,
    wsUsers,
    communityId,
    channels,
  };
}

// ── VU functions ────────────────────────────────────────────────────────────
export function postMessage(data) {
  // Round-robin sender and channel per VU iteration
  const senderIdx = exec.vu.idInTest % data.senders.length;
  const sender = data.senders[senderIdx];
  const channelId = data.channels[exec.vu.iterationInScenario % data.channels.length];

  const content = `cap-${RUN_ID}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Math.random().toString(36).slice(2, 10)}`;
  const paddedContent = content.padEnd(MESSAGE_SIZE, 'x').slice(0, MESSAGE_SIZE);

  const t0 = Date.now();
  const res = http.post(
    `${BASE_URL}/messages`,
    JSON.stringify({ channelId, content: paddedContent }),
    baseParams(sender.token, { endpoint: 'messages_post' }),
  );
  const ms = Date.now() - t0;
  messagePostDuration.add(ms);

  if (res.status === 201) {
    messagePost201Total.add(1);
  } else {
    messagePostFailTotal.add(1);
    if (res.status === 0) httpResStatus0.add(1);
    else if (res.status >= 400 && res.status < 500) httpResStatus4xx.add(1);
    else if (res.status >= 500) httpResStatus5xx.add(1);
  }

  const ok = check(res, {
    'post 201': (r) => r.status === 201,
  });
  checksRate.add(ok);

  // Optional: mark read
  if (ENABLE_READ_RECEIPTS && res.status === 201) {
    const body = safeJson(res);
    if (body && body.message && body.message.id) {
      http.put(
        `${BASE_URL}/messages/${body.message.id}/read`,
        null,
        baseParams(sender.token, { endpoint: 'messages_read' }),
      );
    }
  }
}

export function wsListener(data) {
  const wsIdx = (exec.vu.idInTest - 1) % data.wsUsers.length;
  const user = data.wsUsers[wsIdx];
  const url = `${WS_URL}?token=${encodeURIComponent(user.token)}`;

  let received = 0;

  const response = ws.connect(url, { tags: { endpoint: 'ws_listener' } }, (socket) => {
    socket.on('open', () => {
      // Subscribe to all test channels
      for (const chId of data.channels) {
        socket.send(JSON.stringify({ type: 'subscribe', channel: `channel:${chId}` }));
      }
    });

    socket.setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 20000);

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.event === 'message:created') received += 1;
      } catch (_) { /* ignore */ }
    });

    socket.setTimeout(() => {
      socket.close();
    }, parseDurationMs(profile.wsDuration) - 2000);
  });

  const ok = check(response, {
    'ws upgraded': (r) => r && r.status === 101,
  });
  wsConnectRate.add(ok);
  if (!ok) wsDeliveryMissTotal.add(1);

  sleep(1);
}

export function wsDeliveryProbe(data) {
  const sender = data.senders[0];
  const channelId = data.channels[0];
  const url = `${WS_URL}?token=${encodeURIComponent(sender.token)}`;
  const content = `probe-${RUN_ID}-${Date.now()}`;

  let postT0 = 0;
  let delivered = false;
  let finished = false;

  const response = ws.connect(url, { tags: { endpoint: 'ws_delivery_probe' } }, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', channel: `channel:${channelId}` }));
    });

    socket.on('message', (raw) => {
      if (finished) return;
      try {
        const msg = JSON.parse(raw);
        if (msg.event !== 'message:created' || !msg.data) return;
        if (msg.data.content !== content) return;
        if (postT0 <= 0) return;
        const ms = Date.now() - postT0;
        finished = true;
        if (ms <= 15000) {
          wsDeliveryMs.add(ms);
          delivered = true;
        } else {
          wsDeliveryMissTotal.add(1);
        }
        socket.close();
      } catch (_) { /* ignore */ }
    });

    socket.setTimeout(() => {
      if (finished) return;
      const res = http.post(
        `${BASE_URL}/messages`,
        JSON.stringify({ channelId, content }),
        baseParams(sender.token, { endpoint: 'messages_post_probe' }),
      );
      if (res.status !== 201) {
        wsDeliveryMissTotal.add(1);
        finished = true;
        socket.close();
        return;
      }
      postT0 = Date.now();
    }, 1500);

    socket.setTimeout(() => {
      if (finished) return;
      if (!delivered) wsDeliveryMissTotal.add(1);
      finished = true;
      socket.close();
    }, 20000);
  });

  const ok = check(response, {
    'ws probe upgraded': (r) => r && r.status === 101,
  });
  checksRate.add(ok);

  sleep(2);
}

export function teardown(data) {
  if (!data || !data.communityId || !data.senders || !data.senders[0]) return;
  const delRes = http.del(
    `${BASE_URL}/communities/${data.communityId}`,
    null,
    baseParams(data.senders[0].token, { endpoint: 'communities_delete' }),
  );
  if (delRes.status !== 200) {
    console.error(`teardown: community delete returned ${delRes.status}`);
  }
}