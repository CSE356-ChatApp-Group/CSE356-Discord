/**
 * Tests for the WS bootstrap DB hydration cost reduction patch:
 *   - messages mode skips the community_members query
 *   - channel and conversation subscriptions remain present for message delivery
 *   - delivery channels are hydrated before community channels
 *   - per-phase DB timing and per-step hydration timing are observed
 *   - cache invalidation clears the messages-scope key
 */

jest.mock('../src/utils/distributedSingleflight', () => {
  const actual = jest.requireActual<typeof import('../src/utils/distributedSingleflight')>(
    '../src/utils/distributedSingleflight',
  );
  return {
    ...actual,
    withDistributedSingleflight: jest.fn(async ({ load }: { load: () => Promise<unknown> }) =>
      load(),
    ),
  };
});

const { parseChannelKey } = require('../src/websocket/channelKeyParse');
const { createBootstrapSubscriptionsHelpers } = require('../src/websocket/bootstrapSubscriptions');

function metricStub() {
  const observations: Array<{ labels: any; value: number }> = [];
  return {
    inc: jest.fn(),
    observe: jest.fn((labelsOrValue: any, value?: number) => {
      if (typeof labelsOrValue === 'number') {
        observations.push({ labels: {}, value: labelsOrValue });
      } else {
        observations.push({ labels: labelsOrValue, value: value ?? 0 });
      }
    }),
    _observations: observations,
  };
}

function buildHarness(opts: {
  autoSubscribeMode?: string;
  queryResponses?: Array<{ rows: Array<{ id: string }> }>;
  getJsonCache?: jest.Mock;
  wsBootstrapDbQueryDurationMs?: ReturnType<typeof metricStub>;
  wsBootstrapHydrationStepDurationMs?: ReturnType<typeof metricStub>;
  subscribeClient?: jest.Mock;
  subscribeCommunityClient?: jest.Mock;
}) {
  const {
    autoSubscribeMode = 'messages',
    queryResponses = [],
    getJsonCache = jest.fn().mockResolvedValue(null),
    wsBootstrapDbQueryDurationMs: dbMetric = metricStub(),
    wsBootstrapHydrationStepDurationMs: stepMetric = metricStub(),
    subscribeClient: subscribeClientMock = jest.fn().mockResolvedValue(undefined),
    subscribeCommunityClient: subscribeCommunityClientMock = jest.fn(),
  } = opts;

  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    unlink: jest.fn().mockResolvedValue(0),
    pipeline: () => ({
      unlink: jest.fn().mockReturnThis(),
      zscore: jest.fn(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  };

  const query = jest.fn();
  for (const r of queryResponses) {
    query.mockResolvedValueOnce(r);
  }
  query.mockResolvedValue({ rows: [] });

  const helpers = createBootstrapSubscriptionsHelpers({
    redis,
    isRedisOperational: () => true,
    query,
    logger: { warn: jest.fn() },
    staleCacheKey: (k: string) => `stale:${k}`,
    getJsonCache,
    setJsonCacheWithStale: jest.fn().mockResolvedValue(undefined),
    withDistributedSingleflight: jest.requireMock('../src/utils/distributedSingleflight')
      .withDistributedSingleflight,
    wsBootstrapIngressKey: (uid: string, scope: string) => `ingress:${uid}:${scope}`,
    readWsBootstrapIngressCacheBase: jest.fn().mockResolvedValue(null),
    writeWsBootstrapIngressCacheBase: jest.fn().mockResolvedValue(undefined),
    resolvedWsRuntimeConfig: () => ({ autoSubscribeMode }),
    warmWsAclCacheFromChannelList: jest.fn(),
    markChannelRecentConnect: jest.fn().mockResolvedValue(undefined),
    invalidateRecentConnectTargetsCache: jest.fn().mockResolvedValue(undefined),
    subscribeClient: subscribeClientMock,
    subscribeCommunityClient: subscribeCommunityClientMock,
    parseChannelKey,
    wsBootstrapListCacheTotal: metricStub(),
    wsBootstrapChannelsHistogram: metricStub(),
    wsBootstrapBlockedTotal: metricStub(),
    wsBootstrapCachedTotal: metricStub(),
    wsBootstrapDbTotal: metricStub(),
    wsBootstrapWallDurationMs: metricStub(),
    wsBootstrapDbQueryDurationMs: dbMetric,
    wsBootstrapHydrationStepDurationMs: stepMetric,
    WS_BOOTSTRAP_INGRESS_TTL_SECONDS: 3,
    WS_BOOTSTRAP_DB_MAX_IN_FLIGHT: 8,
    WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS: 0,
    WS_BOOTSTRAP_CACHE_TTL_SECONDS: 60,
    WS_BOOTSTRAP_BATCH_SIZE: 96,
  });

  return { query, redis, helpers, dbMetric, stepMetric, subscribeClientMock, subscribeCommunityClientMock };
}

function fakeWs() {
  return { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-1' } as any;
}

// ── DB query scope ─────────────────────────────────────────────────────────────

describe('messages mode: DB query scope', () => {
  it('skips the community_members query — only 2 DB queries fire', async () => {
    const { query, helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      queryResponses: [
        { rows: [{ id: 'conv-1' }] }, // conversations
        { rows: [{ id: 'ch-1' }] },   // channels
      ],
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns no community:* entries in messages mode', async () => {
    const { helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      queryResponses: [
        { rows: [{ id: 'conv-1' }] },
        { rows: [{ id: 'ch-1' }, { id: 'ch-2' }] },
      ],
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    expect(ws._subscriptions).toBeDefined();
    // No community:* in subscriptions
    for (const sub of ws._subscriptions) {
      expect(sub).not.toMatch(/^community:/);
    }
  });

  it('subscribes to channel:* and conversation:* entries in messages mode', async () => {
    const subscribeClientMock = jest.fn().mockResolvedValue(undefined);
    const { helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      queryResponses: [
        { rows: [{ id: 'conv-1' }] },
        { rows: [{ id: 'ch-1' }] },
      ],
      subscribeClient: subscribeClientMock,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    const topics = subscribeClientMock.mock.calls.map((c) => c[1]);
    expect(topics).toContain('channel:ch-1');
    expect(topics).toContain('conversation:conv-1');
  });

  it('fires all 3 queries in full mode', async () => {
    const { query, helpers } = buildHarness({
      autoSubscribeMode: 'full',
      queryResponses: [
        { rows: [] },              // conversations
        { rows: [{ id: 'c-1' }] }, // communities
        { rows: [] },              // channels
      ],
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('includes community:* subscriptions in full mode', async () => {
    const subscribeCommunityClientMock = jest.fn();
    const { helpers } = buildHarness({
      autoSubscribeMode: 'full',
      queryResponses: [
        { rows: [] },
        { rows: [{ id: 'comm-1' }] },
        { rows: [] },
      ],
      subscribeCommunityClient: subscribeCommunityClientMock,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    expect(subscribeCommunityClientMock).toHaveBeenCalledWith(ws, 'comm-1');
  });
});

// ── Phase timing metrics ───────────────────────────────────────────────────────

describe('messages mode: per-phase DB timing', () => {
  it('emits conversations and channels phase timings, not communities', async () => {
    const dbMetric = metricStub();
    const { helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      queryResponses: [
        { rows: [] },
        { rows: [{ id: 'ch-1' }] },
      ],
      wsBootstrapDbQueryDurationMs: dbMetric,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    const phases = dbMetric._observations.map((o) => o.labels.phase);
    expect(phases).toContain('conversations');
    expect(phases).toContain('channels');
    expect(phases).not.toContain('communities');
  });

  it('emits communities phase timing in full mode', async () => {
    const dbMetric = metricStub();
    const { helpers } = buildHarness({
      autoSubscribeMode: 'full',
      queryResponses: [
        { rows: [] },
        { rows: [{ id: 'comm-1' }] },
        { rows: [] },
      ],
      wsBootstrapDbQueryDurationMs: dbMetric,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    const phases = dbMetric._observations.map((o) => o.labels.phase);
    expect(phases).toContain('communities');
  });
});

// ── Hydration step ordering ────────────────────────────────────────────────────

describe('hydration step ordering', () => {
  it('subscribes delivery channels before community channels', async () => {
    const order: string[] = [];
    const subscribeClientMock = jest.fn().mockImplementation(async (_ws: any, ch: string) => {
      order.push(ch);
    });
    const subscribeCommunityClientMock = jest.fn().mockImplementation((_ws: any, id: string) => {
      order.push(`community:${id}`);
    });

    // Full mode so community:* are in the list
    const { helpers } = buildHarness({
      autoSubscribeMode: 'full',
      queryResponses: [
        { rows: [{ id: 'conv-1' }] },          // conversations
        { rows: [{ id: 'comm-1' }] },           // communities
        { rows: [{ id: 'ch-1' }, { id: 'ch-2' }] }, // channels
      ],
      subscribeClient: subscribeClientMock,
      subscribeCommunityClient: subscribeCommunityClientMock,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');

    const communityIdx = order.findIndex((t) => t.startsWith('community:'));
    const lastDeliveryIdx = order.reduce((max, t, i) =>
      !t.startsWith('community:') ? i : max, -1);

    expect(communityIdx).toBeGreaterThan(-1);
    expect(lastDeliveryIdx).toBeGreaterThan(-1);
    // All delivery topics come before the first community topic
    expect(lastDeliveryIdx).toBeLessThan(communityIdx);
  });

  it('emits delivery step timing', async () => {
    const stepMetric = metricStub();
    const { helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      queryResponses: [
        { rows: [] },
        { rows: [{ id: 'ch-1' }] },
      ],
      wsBootstrapHydrationStepDurationMs: stepMetric,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    const steps = stepMetric._observations.map((o) => o.labels.step);
    expect(steps).toContain('delivery');
  });

  it('emits community step timing only when community channels are present', async () => {
    const stepMetric = metricStub();
    const { helpers } = buildHarness({
      autoSubscribeMode: 'full',
      queryResponses: [
        { rows: [] },
        { rows: [{ id: 'comm-1' }] },
        { rows: [] },
      ],
      wsBootstrapHydrationStepDurationMs: stepMetric,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    const steps = stepMetric._observations.map((o) => o.labels.step);
    expect(steps).toContain('community');
  });

  it('does not emit community step when no community channels (messages mode)', async () => {
    const stepMetric = metricStub();
    const { helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      queryResponses: [
        { rows: [] },
        { rows: [{ id: 'ch-1' }] },
      ],
      wsBootstrapHydrationStepDurationMs: stepMetric,
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    const steps = stepMetric._observations.map((o) => o.labels.step);
    expect(steps).not.toContain('community');
  });
});

// ── Cache invalidation correctness ────────────────────────────────────────────

describe('cache invalidation', () => {
  it('invalidateWsBootstrapCaches clears the messages-scope cache key', async () => {
    const { redis, helpers } = buildHarness({ autoSubscribeMode: 'messages' });
    await helpers.invalidateWsBootstrapCaches(['user-42']);
    const unlinkedKeys: string[] = (redis.unlink as jest.Mock).mock.calls.flat();
    expect(unlinkedKeys).toContain('ws:bootstrap:user-42:messages');
  });

  it('cache hit in messages scope returns cached list without hitting DB', async () => {
    const cachedList = ['channel:ch-cached'];
    const { query, helpers } = buildHarness({
      autoSubscribeMode: 'messages',
      getJsonCache: jest.fn().mockResolvedValue(cachedList),
    });
    const ws = fakeWs();
    await helpers.bootstrapWithRetry(ws, 'user-1');
    expect(query).not.toHaveBeenCalled();
  });
});

// ── Delivery correctness after progressive ready ───────────────────────────────

describe('subscribe_channels invite/internal path', () => {
  it('subscribeBootstrapChannel subscribes channel:* topics via subscribeClient', async () => {
    const subscribeClientMock = jest.fn().mockResolvedValue(undefined);
    const { helpers } = buildHarness({ subscribeClient: subscribeClientMock });
    const ws = fakeWs();
    await helpers.subscribeBootstrapChannel(ws, 'channel:abc-123');
    expect(subscribeClientMock).toHaveBeenCalledWith(ws, 'channel:abc-123');
  });

  it('subscribeBootstrapChannel wires community:* topics via subscribeCommunityClient', async () => {
    const subscribeCommunityClientMock = jest.fn();
    const { helpers } = buildHarness({ subscribeCommunityClient: subscribeCommunityClientMock });
    const ws = fakeWs();
    await helpers.subscribeBootstrapChannel(ws, 'community:comm-456');
    expect(subscribeCommunityClientMock).toHaveBeenCalledWith(ws, 'comm-456');
  });
});
