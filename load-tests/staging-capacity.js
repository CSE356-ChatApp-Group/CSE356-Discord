import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://136.114.103.71/api/v1').replace(/\/$/, '');
const WS_URL = (__ENV.WS_URL || BASE_URL.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/ws')).replace(/\/$/, '');
const RUN_ID = __ENV.RUN_ID || `capacity-${Date.now()}`;
const PASSWORD = __ENV.LOADTEST_PASSWORD || 'LoadTest!12345';
const MESSAGE_SIZE = Number(__ENV.MESSAGE_SIZE || 96);
const checksRate = new Rate('capacity_checks');
const wsConnectRate = new Rate('ws_connect_success');
const communitiesDuration = new Trend('communities_req_duration', true);
const conversationsDuration = new Trend('conversations_req_duration', true);
const channelListDuration = new Trend('channel_messages_req_duration', true);
const channelsDuration = new Trend('channels_req_duration', true);
const messagePostDuration = new Trend('message_post_req_duration', true);
const authLoginDuration = new Trend('auth_login_req_duration', true);

const PROFILES = {
  smoke: {
    httpStages: [
      { target: 5, duration: '30s' },
      { target: 15, duration: '1m' },
      { target: 0, duration: '20s' },
    ],
    preAllocatedVUs: 20,
    maxVUs: 60,
    wsVUs: 10,
    wsDuration: '2m',
  },
  // Warm up cache, then ramp to peak — takes ~2m total
  quick: {
    httpStages: [
      { target: 20, duration: '30s' },
      { target: 100, duration: '45s' },
      { target: 0, duration: '15s' },
    ],
    preAllocatedVUs: 60,
    maxVUs: 180,
    wsVUs: 30,
    wsDuration: '1m45s',
  },
  peak: {
    httpStages: [
      { target: 20, duration: '30s' },
      { target: 50, duration: '1m' },
      { target: 100, duration: '1m' },
      { target: 0, duration: '15s' },
    ],
    preAllocatedVUs: 60,
    maxVUs: 180,
    wsVUs: 30,
    wsDuration: '3m',
  },
  // Fast tuning profile (~3m total): 45s warmup to fill PG/Redis caches, then
  // ramp to full peak to get a stable failure rate comparable to break-fast.
  // Use this when iterating on config (pool sizes, circuit breaker) to get a quick
  // signal on failure rate without waiting 6+ minutes per run.
  tune: {
    httpStages: [
      { target: 20,  duration: '45s' },  // cache warmup
      { target: 200, duration: '30s' },  // ramp
      { target: 500, duration: '1m' },   // sustained peak
      { target: 0,   duration: '15s' },  // drain
    ],
    preAllocatedVUs: 100,
    maxVUs: 600,
    wsVUs: 60,
    wsDuration: '2m45s',
  },
  // Faster break test: same load curve but tighter stage durations (~6m30s total).
  // Starts with a 30s cache-warmup stage (matches tune) so results are comparable
  // and don't include cold-cache penalty for the first ramp segment.
  'break-fast': {
    httpStages: [
      { target: 20,  duration: '30s' },  // cache warmup (PG buffer + Redis)
      { target: 25,  duration: '30s' },
      { target: 75,  duration: '1m' },
      { target: 150, duration: '1m' },
      { target: 300, duration: '1m' },
      { target: 500, duration: '1m' },
      { target: 0,   duration: '30s' },
    ],
    preAllocatedVUs: 100,
    maxVUs: 600,
    wsVUs: 60,
    wsDuration: '6m30s',
  },
  break: {
    httpStages: [
      { target: 25, duration: '1m' },
      { target: 75, duration: '2m' },
      { target: 150, duration: '2m' },
      { target: 300, duration: '2m' },
      { target: 500, duration: '2m' },
      { target: 0, duration: '45s' },
    ],
    preAllocatedVUs: 100,
    maxVUs: 600,
    wsVUs: 60,
    wsDuration: '10m',
  },
};

const profile = PROFILES[__ENV.LOAD_PROFILE || 'break'] || PROFILES.break;

// Number of distinct user accounts used for read operations (GET /communities,
// GET /conversations, GET /messages, GET /channels). Spreads reads across N real
// Redis cache keys instead of one, so cache effectiveness under diverse traffic
// is measured accurately rather than showing artificially high hit rates.
// Scale with maxVUs so each reader is shared by at most ~6 VUs at break load.
const NUM_READER_POOL = Math.max(20, Math.ceil(profile.maxVUs / 6));

export const options = {
  discardResponseBodies: true,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    // p(99) instead of max: the max metric is a single-request outlier (GC pause,
    // cold start) and causes spurious threshold breaches that mask real data.
    http_req_duration: ['p(95)<1500', 'p(99)<5000'],
    capacity_checks: ['rate>0.95'],
    ws_connect_success: ['rate>0.95'],
    communities_req_duration: ['p(95)<1200'],
    conversations_req_duration: ['p(95)<1000'],
    channel_messages_req_duration: ['p(95)<1200'],
    channels_req_duration: ['p(95)<1200'],
    message_post_req_duration: ['p(95)<1500'],
    auth_login_req_duration: ['p(95)<2000'],
  },
  scenarios: {
    http_mix: {
      executor: 'ramping-arrival-rate',
      exec: 'httpMix',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: profile.preAllocatedVUs,
      maxVUs: profile.maxVUs,
      stages: profile.httpStages,
      gracefulStop: '30s',
    },
    websocket_presence: {
      executor: 'constant-vus',
      exec: 'presenceSocketStorm',
      vus: profile.wsVUs,
      duration: profile.wsDuration,
      gracefulStop: '10s',
    },
  },
};

function jsonParams(token, tags = {}, keepBody = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const params = { headers, tags };
  if (keepBody) params.responseType = 'text';
  return params;
}

function safeJson(res) {
  try {
    return res.json();
  } catch (_err) {
    return null;
  }
}

function uniqueUser(label) {
  const suffix = `${RUN_ID}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  // Use only the last 8 chars of RUN_ID so the varying label part isn't truncated.
  const runShort = RUN_ID.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  const labelSlug = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return {
    username: `lt-${runShort}-${labelSlug}`.slice(0, 30),
    email: `lt-${suffix}@example.com`,
    password: PASSWORD,
  };
}

function registerOrLogin(label) {
  const creds = uniqueUser(label);
  const registerRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify(creds),
    jsonParams(null, { endpoint: 'auth_register' }, true),
  );

  if (registerRes.status !== 201 && registerRes.status !== 409) {
    throw new Error(`register failed for ${label}: ${registerRes.status} ${registerRes.body}`);
  }

  const startedAt = Date.now();
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: creds.email, password: creds.password }),
    jsonParams(null, { endpoint: 'auth_login' }, true),
  );
  authLoginDuration.add(Date.now() - startedAt);

  const body = safeJson(loginRes);
  const ok = check(loginRes, {
    'login ok': (res) => res.status === 200 && Boolean(body && body.accessToken),
  });
  checksRate.add(ok);

  if (!ok) {
    throw new Error(`login failed for ${label}: ${loginRes.status} ${loginRes.body}`);
  }
  return {
    token: body.accessToken,
    userId: body.user.id,
    creds,
  };
}

// Parallel register+login for a list of credential objects.
// Returns [{token, userId, email}] in the same order as credsList.
function batchCreateUsers(credsList) {
  // Batch register — 409 (already exists) is fine for idempotent reruns.
  http.batch(
    credsList.map((creds) => ({
      method: 'POST',
      url: `${BASE_URL}/auth/register`,
      body: JSON.stringify(creds),
      params: jsonParams(null, { endpoint: 'auth_register' }, true),
    })),
  );
  const loginResponses = http.batch(
    credsList.map((creds) => ({
      method: 'POST',
      url: `${BASE_URL}/auth/login`,
      body: JSON.stringify({ email: creds.email, password: creds.password }),
      params: jsonParams(null, { endpoint: 'auth_login' }, true),
    })),
  );
  return loginResponses.map((res, i) => {
    const body = safeJson(res);
    if (!body || !body.accessToken) {
      throw new Error(`batch user login failed for ${credsList[i].email}: ${res.status} ${res.body}`);
    }
    return { token: body.accessToken, userId: body.user.id, email: credsList[i].email };
  });
}

export function setup() {
  const owner = registerOrLogin('owner');
  const peer = registerOrLogin('peer');

  // Batch-create all secondary users in 2 round-trips (register + login) to
  // keep setup fast regardless of profile.wsVUs or NUM_READER_POOL size.
  //   wsPeers:    distinct user per WS VU — avoids thundering-herd DB queries
  //               for the same userId on every reconnect
  //   readerPool: distinct users for HTTP read ops so each hits its own Redis
  //               cache key, revealing true cache miss rates under diverse load
  const allSecondaryCredentials = [
    ...Array.from({ length: profile.wsVUs }, (_, i) => uniqueUser(`ws-peer-${i}`)),
    ...Array.from({ length: NUM_READER_POOL }, (_, i) => uniqueUser(`reader-${i}`)),
  ];
  const allSecondary = batchCreateUsers(allSecondaryCredentials);
  const wsPeers = allSecondary.slice(0, profile.wsVUs);
  const readerPool = allSecondary.slice(profile.wsVUs);

  const communitySlug = `cap-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  const communityRes = http.post(
    `${BASE_URL}/communities`,
    JSON.stringify({ slug: communitySlug, name: `Capacity ${RUN_ID}`.slice(0, 100), description: 'staging capacity run' }),
    jsonParams(owner.token, { endpoint: 'communities_create' }, true),
  );
  if (communityRes.status !== 201) {
    throw new Error(`community create failed: ${communityRes.status} ${communityRes.body}`);
  }
  const communityId = safeJson(communityRes).community.id;

  // Batch-join peer + all readers so their GET /communities responses are
  // non-empty, making the cached payload realistic.
  http.batch(
    [peer.token, ...readerPool.map((r) => r.token)].map((token) => ({
      method: 'POST',
      url: `${BASE_URL}/communities/${communityId}/join`,
      body: JSON.stringify({}),
      params: jsonParams(token, { endpoint: 'communities_join' }),
    })),
  );

  const channelName = `cap-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 28);
  const channelRes = http.post(
    `${BASE_URL}/channels`,
    JSON.stringify({ communityId, name: channelName, isPrivate: false, description: 'capacity load channel' }),
    jsonParams(owner.token, { endpoint: 'channels_create' }, true),
  );
  if (channelRes.status !== 201) {
    throw new Error(`channel create failed: ${channelRes.status} ${channelRes.body}`);
  }
  const channelId = safeJson(channelRes).channel.id;

  const conversationRes = http.post(
    `${BASE_URL}/conversations`,
    JSON.stringify({ participantIds: [peer.userId] }),
    jsonParams(owner.token, { endpoint: 'conversations_create' }, true),
  );
  if (conversationRes.status !== 201) {
    throw new Error(`conversation create failed: ${conversationRes.status} ${conversationRes.body}`);
  }
  const conversationId = safeJson(conversationRes).conversation.id;

  return {
    ownerToken: owner.token,
    ownerEmail: owner.creds.email,
    peerToken: peer.token,
    peerUserId: peer.userId,
    communityId,
    channelId,
    conversationId,
    wsPeers,
    readerPool,
  };
}

function randomContent(label) {
  const seed = `${label}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Math.random().toString(36).slice(2, 10)}`;
  return seed.padEnd(MESSAGE_SIZE, 'x').slice(0, MESSAGE_SIZE);
}

function listCommunities(token) {
  const res = http.get(`${BASE_URL}/communities`, { headers: { Authorization: `Bearer ${token}` }, tags: { endpoint: 'communities_list' } });
  communitiesDuration.add(res.timings.duration);
  const ok = check(res, { 'communities list 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

function listConversations(token) {
  const res = http.get(`${BASE_URL}/conversations`, { headers: { Authorization: `Bearer ${token}` }, tags: { endpoint: 'conversations_list' } });
  conversationsDuration.add(res.timings.duration);
  const ok = check(res, { 'conversations list 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

function listMessages(token, channelId) {
  const res = http.get(`${BASE_URL}/messages?channelId=${channelId}`, { headers: { Authorization: `Bearer ${token}` }, tags: { endpoint: 'messages_list_channel' } });
  channelListDuration.add(res.timings.duration);
  const ok = check(res, { 'channel message list 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

function listChannels(token, communityId) {
  const res = http.get(`${BASE_URL}/channels?communityId=${communityId}`, { headers: { Authorization: `Bearer ${token}` }, tags: { endpoint: 'channels_list' } });
  channelsDuration.add(res.timings.duration);
  const ok = check(res, { 'channels list 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

function sendChannelMessage(token, channelId) {
  const res = http.post(
    `${BASE_URL}/messages`,
    JSON.stringify({ channelId, content: randomContent('channel') }),
    jsonParams(token, { endpoint: 'messages_post_channel' }),
  );
  messagePostDuration.add(res.timings.duration);
  const ok = check(res, { 'channel message post 201': (r) => r.status === 201 });
  checksRate.add(ok);
}

function sendConversationMessage(token, conversationId) {
  const res = http.post(
    `${BASE_URL}/messages`,
    JSON.stringify({ conversationId, content: randomContent('conversation') }),
    jsonParams(token, { endpoint: 'messages_post_conversation' }),
  );
  messagePostDuration.add(res.timings.duration);
  const ok = check(res, { 'conversation message post 201': (r) => r.status === 201 });
  checksRate.add(ok);
}

function reauthenticate(email) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    jsonParams(null, { endpoint: 'auth_login' }),
  );
  authLoginDuration.add(res.timings.duration);
  const ok = check(res, { 'auth login 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

export function httpMix(data) {
  const roll = Math.random();
  // Pin each VU to a reader so list/read operations hit NUM_READER_POOL distinct
  // Redis keys. Writes still use ownerToken (has ownership) or peerToken
  // (is a conversation participant) — their write paths are not cache-read-heavy.
  const reader = data.readerPool[exec.vu.idInTest % data.readerPool.length];

  if (roll < 0.20) {
    listCommunities(reader.token);
  } else if (roll < 0.36) {
    listConversations(reader.token);
  } else if (roll < 0.50) {
    listMessages(reader.token, data.channelId);
  } else if (roll < 0.62) {
    // GET /channels fires every time a user opens a community in the real app.
    // It exercises per-user private-channel filtering (LATERAL join) and the
    // unread count pipeline — the most complex read query after communities.
    listChannels(reader.token, data.communityId);
  } else if (roll < 0.80) {
    sendChannelMessage(data.ownerToken, data.channelId);
  } else if (roll < 0.90) {
    sendConversationMessage(data.peerToken, data.conversationId);
  } else {
    const vuIdx = (exec.vu.idInTest - 1) % data.wsPeers.length;
    reauthenticate(data.wsPeers[vuIdx].email);
  }

  sleep(Math.random() * 0.35);
}

// Delete the test community so stale public communities don't accumulate in the
// DB across runs. Each run creating a new public community bloats the
// GET /communities CTE query (it scans ALL public communities).
export function teardown(data) {
  if (!data || !data.communityId || !data.ownerToken) return;
  http.del(
    `${BASE_URL}/communities/${data.communityId}`,
    null,
    { headers: { Authorization: `Bearer ${data.ownerToken}` } },
  );
}

export function presenceSocketStorm(data) {
  // Use a VU-specific peer so each concurrent WS connection bootstraps a
  // different user – avoids N simultaneous DB queries for the same userId.
  const vuIdx = (exec.vu.idInTest - 1) % data.wsPeers.length;
  const peer = data.wsPeers[vuIdx];
  const url = `${WS_URL}?token=${encodeURIComponent(peer.token)}`;
  const response = ws.connect(url, { tags: { endpoint: 'ws_presence' } }, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', channel: `user:${peer.userId}` }));
      socket.send(JSON.stringify({ type: 'presence', status: 'online', awayMessage: null }));
    });

    socket.setInterval(() => {
      socket.send(JSON.stringify({ type: 'activity' }));
    }, 5000);

    socket.setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 15000);

    socket.setTimeout(() => {
      socket.close();
    }, 60000);
  });

  const ok = check(response, {
    'websocket upgraded': (res) => res && res.status === 101,
  });
  wsConnectRate.add(ok);
  checksRate.add(ok);

  // Backoff on failure to avoid hammering the server at VU-loop speed.
  if (!ok) {
    sleep(1 + Math.random() * 2);
  }
}
