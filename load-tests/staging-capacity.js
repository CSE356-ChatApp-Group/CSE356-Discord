import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * k6’s embedded Babel does not support numeric separators (e.g. `15_000`); use `15000`.
 *
 * Load profiles: default `break` finds the failure envelope; `slo` holds a fixed
 * arrival rate for steady-state SLO measurement (pair with metadata.txt git SHA).
 *
 * **Which run to verify optimization KPIs**
 * - **slo** — Fixed arrival rate + KPI counter thresholds (login / message post / WS handshake / outage). Run after substantive changes.
 * - **tune** — ~3m fast feedback (latency + dropped iterations) while iterating.
 * - **break-fast** / **break** — Stress envelope; expect latency breaches; still read `optimization_*` in `summary.json`.
 * - **smoke** — Post-deploy sanity.
 * Peak connections ≈ configured `wsVUs` (WS) + HTTP `maxVUs` ceiling; see `summary.json` → `vus.max`, `ws_sessions`.
 *
 * **Grading-shaped delivery (optional)** — `ws_message_delivery` scenario approximates
 * instructor “receive within 15s of send” using WS: HTTP 201 on POST /messages, then
 * time until `message:created` on the same channel subscription. Enabled for `slo`
 * (constant-arrival profile) or when `LOADTEST_WS_MESSAGE_DELIVERY_PROBE=1`. Metrics:
 * `message_ws_delivery_after_post_ms`, `optimization_ws_message_delivery_miss_total`.
 *
 * **Multi-listener (N members must all see the event)** — k6’s single-VU probe does not
 * model “every listener counts separately.” For that, run backend integration:
 * `describe('Channel message multi-listener delivery')` in `backend/tests/websocket.test.ts`
 * (CI) or extend Playwright `delivery-fanout.spec.ts` against staging.
 *
 * **DM burst (WS user-feed path)** — `LOAD_PROFILE=ws-dm-burst`: group DM with N listeners
 * on `user:<id>`, one VU POSTs a burst of DMs (`LOADTEST_DM_BURST_COUNT`). Stresses
 * `deliverUserFeedMessage` / outbound queue. Run: `npm run load:staging:ws-dm-burst`.
 */

/** Classify HTTP responses so reports can separate timeouts vs 503 (shed / pool) vs other errors. */
const httpResStatus0 = new Counter('http_res_status_0_total');
const httpResStatus503 = new Counter('http_res_status_503_total');
const httpResStatus4xx = new Counter('http_res_status_4xx_total');
const httpResStatus5xxOther = new Counter('http_res_status_5xx_other_total');
const httpErrorByEndpoint = new Counter('http_error_by_endpoint_total');

/** KPI roll-ups (map to scorecard: login fails, delivery/post fails, WS handshake fails, HTTP outage). */
const optimizationLoginFailTotal = new Counter('optimization_login_fail_total');
const optimizationMessagePostFailTotal = new Counter('optimization_message_post_fail_total');
const optimizationWsHandshakeFailTotal = new Counter('optimization_ws_handshake_fail_total');
/** Timeouts (0) or any 5xx — user-visible degradation. */
const optimizationHttpOutageTotal = new Counter('optimization_http_outage_total');
/** WS: ms from successful POST /messages to first matching `message:created` frame. */
const messageWsDeliveryAfterPostMs = new Trend('message_ws_delivery_after_post_ms', true);
/** WS probe: no matching frame within SLA or HTTP post / upgrade failure. */
const optimizationWsMessageDeliveryMissTotal = new Counter('optimization_ws_message_delivery_miss_total');

function recordHttpStatus(res, endpoint = 'unknown') {
  if (!res) return;
  const s = res.status;
  if (s === 0 || s >= 500) optimizationHttpOutageTotal.add(1);
  if (s === 0) httpResStatus0.add(1);
  else if (s === 503) httpResStatus503.add(1);
  else if (s >= 400 && s < 500) httpResStatus4xx.add(1);
  else if (s >= 500 && s !== 503) httpResStatus5xxOther.add(1);
  if (s === 0 || s >= 400) {
    const statusClass = s === 0 ? '0xx' : `${Math.floor(s / 100)}xx`;
    httpErrorByEndpoint.add(1, { endpoint, status: String(s), status_class: statusClass });
  }
}

const BASE_URL = (__ENV.BASE_URL || 'http://136.114.103.71/api/v1').replace(/\/$/, '');
const WS_URL = (__ENV.WS_URL || BASE_URL.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/ws')).replace(/\/$/, '');
const RUN_ID = __ENV.RUN_ID || `capacity-${Date.now()}`;
const PASSWORD = __ENV.LOADTEST_PASSWORD || 'LoadTest!12345';
const MESSAGE_SIZE = Number(__ENV.MESSAGE_SIZE || 96);
/** Optional: e.g. 45s — requests slower than this become status 0 (surfaces timeouts in reports). */
const LOADTEST_HTTP_TIMEOUT_MS = __ENV.LOADTEST_HTTP_TIMEOUT_MS || '';
const checksRate = new Rate('capacity_checks');
const wsConnectRate = new Rate('ws_connect_success');
const communitiesDuration = new Trend('communities_req_duration', true);
const conversationsDuration = new Trend('conversations_req_duration', true);
const channelListDuration = new Trend('channel_messages_req_duration', true);
const channelsDuration = new Trend('channels_req_duration', true);
const messagePostDuration = new Trend('message_post_req_duration', true);
const authLoginDuration = new Trend('auth_login_req_duration', true);

function parseRatioEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

const HTTP_MIX = (() => {
  // Defaults match observed prod traffic (2026-04-18, 5000-request nginx sample):
  //   80.2% PUT /messages/:id/read
  //    7.7% POST /messages (channel)
  //    1.9% PATCH /users/me  → baked into reauth
  //    1.6% POST /auth/login → baked into reauth
  //    ~2%  communities/conversations/channels/search (misc)
  // Override any ratio via LOADTEST_MIX_* env vars (values are re-normalised to sum=1).
  const mix = {
    communities: parseRatioEnv('LOADTEST_MIX_COMMUNITIES', 0.03),
    conversations: parseRatioEnv('LOADTEST_MIX_CONVERSATIONS', 0.02),
    messagesList: parseRatioEnv('LOADTEST_MIX_MESSAGES_LIST', 0.03),
    channels: parseRatioEnv('LOADTEST_MIX_CHANNELS', 0.01),
    messageRead: parseRatioEnv('LOADTEST_MIX_MESSAGE_READ', 0.80),
    postChannel: parseRatioEnv('LOADTEST_MIX_POST_CHANNEL', 0.08),
    postConversation: parseRatioEnv('LOADTEST_MIX_POST_CONVERSATION', 0.01),
    reauth: parseRatioEnv('LOADTEST_MIX_REAUTH', 0.02),
  };
  const total = Object.values(mix).reduce((sum, v) => sum + v, 0);
  if (total <= 0) return mix;
  Object.keys(mix).forEach((k) => {
    mix[k] = mix[k] / total;
  });
  return mix;
})();
const vuReadState = {};

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
  //
  // VU headroom must match peak arrival rate × iteration duration (see break-fast).
  // Previously maxVUs=600 caused large dropped_iterations under peak — raised toward
  // break-fast so the bottleneck read is mostly staging, not the k6 scheduler.
  tune: {
    httpStages: [
      { target: 20,  duration: '45s' },  // cache warmup
      { target: 200, duration: '30s' },  // ramp
      { target: 500, duration: '1m' },   // sustained peak
      { target: 0,   duration: '15s' },  // drain
    ],
    preAllocatedVUs: 400,
    maxVUs: 2000,
    wsVUs: 60,
    wsDuration: '2m45s',
  },
  // Faster break test: same load curve but tighter stage durations (~6m30s total).
  // Starts with a 30s cache-warmup stage (matches tune) so results are comparable
  // and don't include cold-cache penalty for the first ramp segment.
  // Peak ~500 iter/s × ~one HTTP req/iter. Under overload, iteration duration can
  // exceed 10s, so required VUs ≈ rate × duration (e.g. 500×12 ≈ 6000 ceiling).
  // Cap here balances honest arrival-rate with typical k6 runner RAM (~3k VUs).
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
    preAllocatedVUs: 480,
    maxVUs: 3200,
    wsVUs: 60,
    wsDuration: '6m30s',
  },
  break: {
    httpStages: [
      { target: 20, duration: '30s' }, // cache warmup (aligned with break-fast for comparable runs)
      { target: 25, duration: '1m' },
      { target: 75, duration: '2m' },
      { target: 150, duration: '2m' },
      { target: 300, duration: '2m' },
      { target: 500, duration: '2m' },
      { target: 0, duration: '45s' },
    ],
    // High preAllocated/max so ramping-arrival-rate does not drop iterations once
    // the target rate exceeds what few warm VUs can schedule (see dropped_iterations in report).
    preAllocatedVUs: 480,
    maxVUs: 3200,
    wsVUs: 60,
    wsDuration: '10m',
  },
  /**
   * Steady-state SLO probe: fixed HTTP arrival rate (not a ramp-to-break curve).
   * Use scripts/run-staging-capacity.sh slo — metadata.txt records git SHA + env placeholders.
   */
  slo: {
    arrivalMode: 'constant',
    constantRate: 28,
    timeUnit: '1s',
    constantDuration: '8m',
    preAllocatedVUs: 120,
    maxVUs: 280,
    wsVUs: 40,
    wsDuration: '8m30s',
    maxFailureRate: 0.01,
    httpP95Ms: 2000,
    httpP99Ms: 5500,
    /** Tight KPI gates for steady-state verification (~8m @ 28 iter/s). */
    optimizationKpiThresholds: {
      optimization_login_fail_total: ['count<8'],
      optimization_message_post_fail_total: ['count<15'],
      optimization_ws_handshake_fail_total: ['count<6'],
      optimization_http_outage_total: ['count<80'],
      optimization_ws_message_delivery_miss_total: ['count<5'],
    },
  },

  /**
   * Prod-replica profile — mirrors observed prod traffic as of 2026-04-18.
   *
   * Observed from last 5000 nginx access log lines:
   *   RPS:  median=196  p95=296  max=297
   *   Mix:  80.2% PUT /messages/:id/read
   *          7.7% POST /messages
   *          7.8% GET /ws (WS upgrades — modelled as wsVUs)
   *          1.9% PATCH /users/me
   *          1.6% POST /auth/login
   *          0.8% other (join community, register, search, conversations)
   *   Latency (p50/p95): read=30ms/67ms  post=40ms/82ms  login=12ms/36ms
   *   Pool:  ~23/80 active per worker, 0 waiting
   *   CPU:   load avg 2.8–3.4 on 8 vCPU (~35–42% utilised)
   *
   * Run with: LOAD_PROFILE=prod-replica npm run load:staging:slo
   * Or:       k6 run -e LOAD_PROFILE=prod-replica load-tests/staging-capacity.js
   *
   * Tune the HTTP_MIX env vars to match the prod snapshot:
   *   LOADTEST_MIX_MESSAGE_READ=0.80 LOADTEST_MIX_POST_CHANNEL=0.08
   *   LOADTEST_MIX_REAUTH=0.02       LOADTEST_MIX_COMMUNITIES=0.03
   *   LOADTEST_MIX_CONVERSATIONS=0.02 LOADTEST_MIX_MESSAGES_LIST=0.03
   *   LOADTEST_MIX_CHANNELS=0.01     LOADTEST_MIX_POST_CONVERSATION=0.01
   *
   * Constant arrival rate of 200 iter/s ≈ prod median; wsVUs=120 models the ~23
   * concurrent WS connections per worker × 4 workers at steady state plus headroom
   * for reconnect churn (~30% extra).  maxVUs is high so k6 isn't the bottleneck.
   */
  /**
   * 5-worker break profile — arrival-rate stepped staircase to reveal the collapse shape.
   *
   * Uses ramping-arrival-rate so k6 keeps offering load at the target rate regardless
   * of server response time.  When the server falls behind, dropped_iterations climbs,
   * p95 latency rises, 503s appear, and the DB pool queue forms — in that order.
   * Each step dwells 2 minutes so metrics stabilise before the next step.
   *
   * Design targets (5 workers × 8 vCPU staging = prod equivalent):
   *   200 iter/s  — prod baseline (grader steady-state)
   *   400 iter/s  — 2× prod (comfortable headroom check)
   *   600 iter/s  — CPU approaches single-worker saturation
   *   800 iter/s  — event loop lag expected to emerge (~20ms stage 1)
   *   1100 iter/s — DB pool queue forms, overload stage 2 likely
   *   1500 iter/s — deliberate overshoot; collapse / 503 cascade visible here
   *
   * wsVUs=200: 5 workers × ~40 concurrent WS per worker at high load.
   * maxVUs=10000: at 1500 iter/s × 10s response under collapse = 15000 needed;
   *   cap at 10000 to keep k6 runner memory sane — dropped iterations above this
   *   are expected and are themselves signal (server can't drain fast enough).
   *
   * Run with:  npm run load:staging:break-5w
   * Requires:  staging deployed with CHATAPP_INSTANCES=5
   */
  'break-5w': {
    httpStages: [
      { target: 20,   duration: '30s' },  // cache warmup
      { target: 200,  duration: '2m' },   // prod baseline
      { target: 400,  duration: '2m' },   // 2× headroom
      { target: 600,  duration: '2m' },   // CPU pressure begins
      { target: 800,  duration: '2m' },   // event-loop lag zone
      { target: 1100, duration: '2m' },   // pool queue / overload stage 2
      { target: 1500, duration: '2m' },   // overshoot — collapse visible
      { target: 0,    duration: '30s' },  // drain
    ],
    preAllocatedVUs: 1200,
    maxVUs: 10000,
    wsVUs: 200,
    wsDuration: '13m',
    // Thresholds are intentionally loose — we WANT to breach them to see where.
    // The report timeline and Prometheus snapshot tell the real story.
    maxFailureRate: 0.50,
    httpP95Ms: 10000,
    httpP99Ms: 20000,
  },

  'prod-replica': {
    arrivalMode: 'constant',
    constantRate: 200,
    timeUnit: '1s',
    constantDuration: '8m',
    preAllocatedVUs: 600,
    maxVUs: 1600,
    wsVUs: 120,
    wsDuration: '8m30s',
    maxFailureRate: 0.01,
    httpP95Ms: 200,
    httpP99Ms: 500,
    optimizationKpiThresholds: {
      optimization_login_fail_total: ['count<20'],
      optimization_message_post_fail_total: ['count<30'],
      optimization_ws_handshake_fail_total: ['count<15'],
      optimization_http_outage_total: ['count<100'],
      optimization_ws_message_delivery_miss_total: ['count<10'],
    },
  },

  /**
   * WebSocket DM delivery stress: N concurrent clients subscribe to `user:<id>`,
   * one client bursts POST /messages to a group DM. No HTTP mix / presence storm.
   * Tune: LOADTEST_DM_LISTENERS (2..wsVUs), LOADTEST_DM_BURST_COUNT (10..2000).
   */
  'ws-dm-burst': {
    httpStages: [],
    preAllocatedVUs: 50,
    maxVUs: 50,
    wsVUs: 40,
    wsDuration: '3m',
    maxFailureRate: 0.20,
    httpP95Ms: 120000,
    httpP99Ms: 180000,
    optimizationKpiThresholds: {
      optimization_message_post_fail_total: ['count<50'],
      optimization_ws_handshake_fail_total: ['count<20'],
      optimization_ws_message_delivery_miss_total: ['count<2000'],
    },
  },
};

const loadProfileName = __ENV.LOAD_PROFILE || 'break';
const IS_WS_DM_BURST = loadProfileName === 'ws-dm-burst';
const profile = PROFILES[loadProfileName] || PROFILES.break;

const DM_BURST_COUNT = IS_WS_DM_BURST
  ? Math.min(2000, Math.max(10, Number(__ENV.LOADTEST_DM_BURST_COUNT || 150)))
  : 0;
const DM_LISTENER_COUNT = IS_WS_DM_BURST
  ? Math.min(
      profile.wsVUs,
      Math.min(32, Math.max(2, Number(__ENV.LOADTEST_DM_LISTENERS || 8))),
    )
  : 0;

const useConstantArrival = profile.arrivalMode === 'constant';

// Number of distinct user accounts used for read operations (GET /communities,
// GET /conversations, GET /messages, GET /channels). Spreads reads across N real
// Redis cache keys instead of one, so cache effectiveness under diverse traffic
// is measured accurately rather than showing artificially high hit rates.
// Scale with maxVUs (~one reader per 6 VUs) but cap so setup() does not create
// hundreds of accounts when maxVUs is high for arrival-rate headroom only.
const READER_POOL_CAP = 220;
const NUM_READER_POOL = IS_WS_DM_BURST
  ? 5
  : Math.max(20, Math.min(READER_POOL_CAP, Math.ceil(profile.maxVUs / 6)));

const httpThresholds = {
  http_req_failed: [`rate<${profile.maxFailureRate != null ? profile.maxFailureRate : 0.05}`],
  http_req_duration: [
    `p(95)<${profile.httpP95Ms != null ? profile.httpP95Ms : 1500}`,
    `p(99)<${profile.httpP99Ms != null ? profile.httpP99Ms : 5000}`,
  ],
  capacity_checks: ['rate>0.95'],
  ws_connect_success: ['rate>0.95'],
  communities_req_duration: [`p(95)<${profile.communitiesP95Ms != null ? profile.communitiesP95Ms : 1200}`],
  conversations_req_duration: [`p(95)<${profile.conversationsP95Ms != null ? profile.conversationsP95Ms : 1000}`],
  channel_messages_req_duration: [`p(95)<${profile.channelMessagesP95Ms != null ? profile.channelMessagesP95Ms : 1200}`],
  channels_req_duration: [`p(95)<${profile.channelsP95Ms != null ? profile.channelsP95Ms : 1200}`],
  message_post_req_duration: [`p(95)<${profile.messagePostP95Ms != null ? profile.messagePostP95Ms : 1500}`],
  auth_login_req_duration: [`p(95)<${profile.authLoginP95Ms != null ? profile.authLoginP95Ms : 2000}`],
};
if (profile.optimizationKpiThresholds) {
  Object.assign(httpThresholds, profile.optimizationKpiThresholds);
}
if (IS_WS_DM_BURST) {
  httpThresholds.ws_connect_success = ['rate>0.85'];
  httpThresholds.capacity_checks = ['rate>0.80'];
}

const wsMessageDeliveryProbeEnabled =
  !IS_WS_DM_BURST &&
  (__ENV.LOADTEST_WS_MESSAGE_DELIVERY_PROBE === '1' ||
    __ENV.LOADTEST_WS_MESSAGE_DELIVERY_PROBE === 'true' ||
    profile.arrivalMode === 'constant');

const wsMessageDeliveryScenarioDuration =
  profile.constantDuration || profile.wsDuration || '2m';

const httpMixScenario = useConstantArrival
  ? {
      executor: 'constant-arrival-rate',
      exec: 'httpMix',
      rate: profile.constantRate,
      timeUnit: profile.timeUnit || '1s',
      duration: profile.constantDuration,
      preAllocatedVUs: profile.preAllocatedVUs,
      maxVUs: profile.maxVUs,
      gracefulStop: '30s',
    }
  : {
      executor: 'ramping-arrival-rate',
      exec: 'httpMix',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: profile.preAllocatedVUs,
      maxVUs: profile.maxVUs,
      stages: profile.httpStages,
      gracefulStop: '30s',
    };

const scenarioTable = IS_WS_DM_BURST
  ? {
      dm_burst_listen: {
        executor: 'constant-vus',
        exec: 'dmBurstListener',
        vus: DM_LISTENER_COUNT,
        duration: '2m50s',
        gracefulStop: '40s',
      },
      dm_burst_send: {
        executor: 'constant-vus',
        exec: 'dmBurstSender',
        vus: 1,
        startTime: '20s',
        duration: '2m20s',
        gracefulStop: '45s',
      },
    }
  : {
      http_mix: httpMixScenario,
      websocket_presence: {
        executor: 'constant-vus',
        exec: 'presenceSocketStorm',
        vus: profile.wsVUs,
        duration: profile.wsDuration,
        gracefulStop: '10s',
      },
    };

if (!IS_WS_DM_BURST && wsMessageDeliveryProbeEnabled) {
  scenarioTable.ws_message_delivery = {
    executor: 'constant-vus',
    exec: 'channelMessageDeliveryProbe',
    vus: 1,
    duration: wsMessageDeliveryScenarioDuration,
    gracefulStop: '25s',
  };
}

export const options = {
  discardResponseBodies: true,
  thresholds: httpThresholds,
  scenarios: scenarioTable,
};

function baseHttpParams(token, tags = {}, extra = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // k6's transpiler rejects object spread in literals; Object.assign is supported.
  const params = Object.assign({ headers, tags }, extra);
  if (LOADTEST_HTTP_TIMEOUT_MS) params.timeout = `${LOADTEST_HTTP_TIMEOUT_MS}ms`;
  return params;
}

function jsonParams(token, tags = {}, keepBody = false) {
  const params = baseHttpParams(token, tags);
  if (keepBody) params.responseType = 'text';
  return params;
}

/** GET helpers use the same timeout as POST (list endpoints were bypassing jsonParams). */
function getAuthParams(token, tags, keepBody = false) {
  const params = baseHttpParams(token, tags);
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
  // Usernames must stay <=32 chars (API validation).  Do **not** use only the
  // last 8 alnum chars of RUN_ID — for profile "break-fast" that becomes
  // "breakfast" on every run, so register returns 409 and login-by-new-email 401s.
  const runKey = RUN_ID.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const labelSlug = label.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 10);
  const username = `lt-${runKey}-${labelSlug}`.slice(0, 30);
  return {
    username,
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
  recordHttpStatus(registerRes, 'auth_register');

  if (registerRes.status !== 201 && registerRes.status !== 409) {
    throw new Error(`register failed for ${label}: ${registerRes.status} ${registerRes.body}`);
  }

  const startedAt = Date.now();
  // Passport local strategy accepts username in the `email` JSON field.
  // After a 409 register (username reused), login-by-email would miss the DB row.
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: creds.username, password: creds.password }),
    jsonParams(null, { endpoint: 'auth_login' }, true),
  );
  recordHttpStatus(loginRes, 'auth_login');
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
// Returns [{token, userId, email, username}] in the same order as credsList.
function batchCreateUsers(credsList) {
  // Batch register — 409 (already exists) is fine for idempotent reruns.
  const registerResponses = http.batch(
    credsList.map((creds) => ({
      method: 'POST',
      url: `${BASE_URL}/auth/register`,
      body: JSON.stringify(creds),
      params: jsonParams(null, { endpoint: 'auth_register' }, true),
    })),
  );
  for (const res of registerResponses) recordHttpStatus(res, 'auth_register');
  const loginResponses = http.batch(
    credsList.map((creds) => ({
      method: 'POST',
      url: `${BASE_URL}/auth/login`,
      body: JSON.stringify({ email: creds.username, password: creds.password }),
      params: jsonParams(null, { endpoint: 'auth_login' }, true),
    })),
  );
  for (const res of loginResponses) recordHttpStatus(res, 'auth_login');
  return loginResponses.map((res, i) => {
    const body = safeJson(res);
    if (!body || !body.accessToken) {
      throw new Error(`batch user login failed for ${credsList[i].username}: ${res.status} ${res.body}`);
    }
    return {
      token: body.accessToken,
      userId: body.user.id,
      email: credsList[i].email,
      username: credsList[i].username,
    };
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
  recordHttpStatus(communityRes, 'communities_create');
  if (communityRes.status !== 201) {
    throw new Error(`community create failed: ${communityRes.status} ${communityRes.body}`);
  }
  const communityId = safeJson(communityRes).community.id;

  // Batch-join peer + all readers so their GET /communities responses are
  // non-empty, making the cached payload realistic.
  // ws-dm-burst: join DM listener accounts too (same community as other participants).
  const joinTokens = [peer.token];
  if (IS_WS_DM_BURST) {
    for (let i = 0; i < DM_LISTENER_COUNT; i += 1) {
      joinTokens.push(wsPeers[i].token);
    }
  }
  joinTokens.push(...readerPool.map((r) => r.token));
  const joinResponses = http.batch(
    joinTokens.map((token) => ({
      method: 'POST',
      url: `${BASE_URL}/communities/${communityId}/join`,
      body: JSON.stringify({}),
      params: jsonParams(token, { endpoint: 'communities_join' }),
    })),
  );
  for (const res of joinResponses) recordHttpStatus(res, 'communities_join');

  const channelName = `cap-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 28);
  const channelRes = http.post(
    `${BASE_URL}/channels`,
    JSON.stringify({ communityId, name: channelName, isPrivate: false, description: 'capacity load channel' }),
    jsonParams(owner.token, { endpoint: 'channels_create' }, true),
  );
  recordHttpStatus(channelRes, 'channels_create');
  if (channelRes.status !== 201) {
    throw new Error(`channel create failed: ${channelRes.status} ${channelRes.body}`);
  }
  const channelId = safeJson(channelRes).channel.id;

  const participantIdsForConversation = IS_WS_DM_BURST
    ? wsPeers.slice(0, DM_LISTENER_COUNT).map((p) => p.userId)
    : [peer.userId];
  const conversationRes = http.post(
    `${BASE_URL}/conversations`,
    JSON.stringify({ participantIds: participantIdsForConversation }),
    jsonParams(owner.token, { endpoint: 'conversations_create' }, true),
  );
  recordHttpStatus(conversationRes, 'conversations_create');
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
    isWsDmBurst: IS_WS_DM_BURST,
    dmBurstPrefix: IS_WS_DM_BURST ? `dm-${RUN_ID}-` : '',
    dmBurstExpected: IS_WS_DM_BURST ? DM_BURST_COUNT : 0,
    dmListenerPeers: IS_WS_DM_BURST ? wsPeers.slice(0, DM_LISTENER_COUNT) : [],
  };
}

function randomContent(label) {
  const seed = `${label}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Math.random().toString(36).slice(2, 10)}`;
  return seed.padEnd(MESSAGE_SIZE, 'x').slice(0, MESSAGE_SIZE);
}

function listCommunities(token) {
  const res = http.get(`${BASE_URL}/communities`, getAuthParams(token, { endpoint: 'communities_list' }));
  recordHttpStatus(res, 'communities_list');
  communitiesDuration.add(res.timings.duration);
  const ok = check(res, { 'communities list 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

function listConversations(token) {
  const res = http.get(`${BASE_URL}/conversations`, getAuthParams(token, { endpoint: 'conversations_list' }));
  recordHttpStatus(res, 'conversations_list');
  conversationsDuration.add(res.timings.duration);
  const ok = check(res, { 'conversations list 200': (r) => r.status === 200 });
  checksRate.add(ok);
}

function listMessages(token, channelId, keepBody = false) {
  const res = http.get(
    `${BASE_URL}/messages?channelId=${channelId}`,
    getAuthParams(token, { endpoint: 'messages_list_channel' }, keepBody),
  );
  recordHttpStatus(res, 'messages_list_channel');
  channelListDuration.add(res.timings.duration);
  const ok = check(res, { 'channel message list 200': (r) => r.status === 200 });
  checksRate.add(ok);
  if (!keepBody || res.status !== 200) return null;
  const payload = safeJson(res);
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const last = messages.length ? messages[messages.length - 1] : null;
  return last && last.id ? String(last.id) : null;
}

function listChannels(token, communityId) {
  const res = http.get(`${BASE_URL}/channels?communityId=${communityId}`, getAuthParams(token, { endpoint: 'channels_list' }));
  recordHttpStatus(res, 'channels_list');
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
  recordHttpStatus(res, 'messages_post_channel');
  messagePostDuration.add(res.timings.duration);
  const ok = check(res, { 'channel message post 201': (r) => r.status === 201 });
  if (!ok) optimizationMessagePostFailTotal.add(1);
  checksRate.add(ok);
}

function sendConversationMessage(token, conversationId) {
  const res = http.post(
    `${BASE_URL}/messages`,
    JSON.stringify({ conversationId, content: randomContent('conversation') }),
    jsonParams(token, { endpoint: 'messages_post_conversation' }),
  );
  recordHttpStatus(res, 'messages_post_conversation');
  messagePostDuration.add(res.timings.duration);
  const ok = check(res, { 'conversation message post 201': (r) => r.status === 201 });
  if (!ok) optimizationMessagePostFailTotal.add(1);
  checksRate.add(ok);
}

function reauthenticate(loginId) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: loginId, password: PASSWORD }),
    jsonParams(null, { endpoint: 'auth_login' }),
  );
  recordHttpStatus(res, 'auth_login');
  authLoginDuration.add(res.timings.duration);
  const ok = check(res, { 'auth login 200': (r) => r.status === 200 });
  if (!ok) optimizationLoginFailTotal.add(1);
  checksRate.add(ok);
}

function markMessageRead(token, messageId) {
  if (!messageId) return;
  const res = http.put(
    `${BASE_URL}/messages/${messageId}/read`,
    null,
    getAuthParams(token, { endpoint: 'messages_read_mark' }),
  );
  recordHttpStatus(res, 'messages_read_mark');
  const ok = check(res, {
    'message read mark ok': (r) => r.status === 200 || r.status === 404,
  });
  checksRate.add(ok);
}

export function httpMix(data) {
  const roll = Math.random();
  // Pin each VU to a reader so list/read operations hit NUM_READER_POOL distinct
  // Redis keys. Writes still use ownerToken (has ownership) or peerToken
  // (is a conversation participant) — their write paths are not cache-read-heavy.
  const reader = data.readerPool[exec.vu.idInTest % data.readerPool.length];
  const state = vuReadState[exec.vu.idInTest] || (vuReadState[exec.vu.idInTest] = {});
  let cursor = 0;
  cursor += HTTP_MIX.communities;
  if (roll < cursor) {
    listCommunities(reader.token);
    return sleep(Math.random() * 0.35);
  }
  cursor += HTTP_MIX.conversations;
  if (roll < cursor) {
    listConversations(reader.token);
    return sleep(Math.random() * 0.35);
  }
  cursor += HTTP_MIX.messagesList;
  if (roll < cursor) {
    listMessages(reader.token, data.channelId);
    return sleep(Math.random() * 0.35);
  }
  cursor += HTTP_MIX.channels;
  if (roll < cursor) {
    // GET /channels fires every time a user opens a community in the real app.
    // It exercises per-user private-channel filtering (LATERAL join) and the
    // unread count pipeline — the most complex read query after communities.
    listChannels(reader.token, data.communityId);
    return sleep(Math.random() * 0.35);
  }
  cursor += HTTP_MIX.messageRead;
  if (roll < cursor) {
    let messageId = state.lastReadMessageId || null;
    if (!messageId) {
      messageId = listMessages(reader.token, data.channelId, true);
      if (messageId) state.lastReadMessageId = messageId;
    }
    markMessageRead(reader.token, messageId);
    return sleep(Math.random() * 0.35);
  }
  cursor += HTTP_MIX.postChannel;
  if (roll < cursor) {
    sendChannelMessage(data.ownerToken, data.channelId);
    return sleep(Math.random() * 0.35);
  }
  cursor += HTTP_MIX.postConversation;
  if (roll < cursor) {
    sendConversationMessage(data.peerToken, data.conversationId);
    return sleep(Math.random() * 0.35);
  }
  const vuIdx = (exec.vu.idInTest - 1) % data.wsPeers.length;
  reauthenticate(data.wsPeers[vuIdx].username);

  sleep(Math.random() * 0.35);
}

// Delete the test community so stale public communities don't accumulate in the
// DB across runs. GET /communities (no limit) lists all visible rows; member_count
// is denormalized on communities (no live aggregate over the full visible set).
export function teardown(data) {
  if (!data || !data.communityId || !data.ownerToken) return;
  const delRes = http.del(
    `${BASE_URL}/communities/${data.communityId}`,
    null,
    getAuthParams(data.ownerToken, { endpoint: 'communities_delete' }),
  );
  recordHttpStatus(delRes, 'communities_delete');
}

/** One WS client subscribes to the capacity channel, POSTs a message, measures realtime delivery. */
export function channelMessageDeliveryProbe(data) {
  if (!data || !data.ownerToken || !data.channelId) {
    sleep(1);
    return;
  }

  const token = data.ownerToken;
  const channelId = data.channelId;
  const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
  const content = `deliver-probe-${RUN_ID}-${exec.vu.idInTest}-${Date.now()}`;

  let postT0 = 0;
  let deliveredWithinSla = false;
  let finished = false;

  const response = ws.connect(
    url,
    { tags: { endpoint: 'ws_message_delivery_probe' } },
    (socket) => {
      socket.on('open', () => {
        socket.send(
          JSON.stringify({ type: 'subscribe', channel: `channel:${channelId}` }),
        );
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
            messageWsDeliveryAfterPostMs.add(ms);
            deliveredWithinSla = true;
          } else {
            optimizationWsMessageDeliveryMissTotal.add(1);
          }
          socket.close();
        } catch (_err) {
          /* ignore */
        }
      });

      socket.setTimeout(() => {
        if (finished) return;
        const res = http.post(
          `${BASE_URL}/messages`,
          JSON.stringify({ channelId, content }),
          jsonParams(token, { endpoint: 'messages_post_ws_probe' }),
        );
        recordHttpStatus(res, 'messages_post_ws_probe');
        if (res.status !== 201) {
          optimizationWsMessageDeliveryMissTotal.add(1);
          finished = true;
          socket.close();
          return;
        }
        postT0 = Date.now();
      }, 1200);

      socket.setTimeout(() => {
        if (finished) return;
        finished = true;
        if (postT0 <= 0) {
          optimizationWsMessageDeliveryMissTotal.add(1);
        } else if (!deliveredWithinSla) {
          optimizationWsMessageDeliveryMissTotal.add(1);
        }
        socket.close();
      }, 20000);
    },
  );

  const ok = check(response, {
    'ws message delivery probe upgraded': (r) => r && r.status === 101,
  });
  checksRate.add(ok);
  if (!ok) optimizationWsMessageDeliveryMissTotal.add(1);

  sleep(2);
}

/** N VUs each open WS, subscribe `user:<id>`, count `message:created` for the burst DM. */
export function dmBurstListener(data) {
  if (!data || !data.isWsDmBurst || !data.dmListenerPeers || !data.dmListenerPeers.length) {
    sleep(1);
    return;
  }
  const idx = (exec.vu.idInTest - 1) % data.dmListenerPeers.length;
  const peer = data.dmListenerPeers[idx];
  const url = `${WS_URL}?token=${encodeURIComponent(peer.token)}`;
  const convId = String(data.conversationId);
  const prefix = data.dmBurstPrefix;
  const expected = data.dmBurstExpected;
  let received = 0;

  const response = ws.connect(url, { tags: { endpoint: 'ws_dm_burst_listen' } }, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', channel: `user:${peer.userId}` }));
    });

    socket.setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 20000);

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.event !== 'message:created' || !msg.data) return;
        const d = msg.data;
        const c = String(d.conversation_id || d.conversationId || '');
        if (c !== convId) return;
        const content = d.content || '';
        if (!content.startsWith(prefix)) return;
        received += 1;
      } catch (_e) {
        /* ignore */
      }
    });

    socket.setTimeout(() => {
      if (received < expected) {
        optimizationWsMessageDeliveryMissTotal.add(expected - received);
      }
      checksRate.add(received >= expected);
      socket.close();
    }, 130000);
  });

  const ok = check(response, { 'dm burst ws upgraded': (r) => r && r.status === 101 });
  checksRate.add(ok);
  if (!ok) {
    optimizationWsHandshakeFailTotal.add(1);
    optimizationWsMessageDeliveryMissTotal.add(expected);
    sleep(2);
    return;
  }
  wsConnectRate.add(true);
}

/** Single VU: rapid POST /messages to the shared group DM (owner). */
export function dmBurstSender(data) {
  if (!data || !data.isWsDmBurst) {
    sleep(1);
    return;
  }
  const prefix = data.dmBurstPrefix;
  const n = data.dmBurstExpected;
  for (let i = 0; i < n; i += 1) {
    const res = http.post(
      `${BASE_URL}/messages`,
      JSON.stringify({ conversationId: data.conversationId, content: `${prefix}${i}` }),
      jsonParams(data.ownerToken, { endpoint: 'messages_post_dm_burst' }),
    );
    recordHttpStatus(res, 'messages_post_dm_burst');
    const ok = check(res, { 'dm burst post 201': (r) => r.status === 201 });
    checksRate.add(ok);
    if (!ok) optimizationMessagePostFailTotal.add(1);
  }
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
  if (!ok) optimizationWsHandshakeFailTotal.add(1);
  wsConnectRate.add(ok);
  checksRate.add(ok);

  // Backoff on failure to avoid hammering the server at VU-loop speed.
  if (!ok) {
    sleep(1 + Math.random() * 2);
  }
}
