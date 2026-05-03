/**
 * WS bootstrap recent-connect hybrid:
 * - Bulk prime ZSET + invalidate before batched subscribeClient (recent_connect timing).
 * - subscribeClient skips duplicate mark/invalidate when channel id is in ws._bootstrapRecentConnectChannelIds.
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
const { createSubscriptionManager } = require('../src/websocket/subscriptionManager');

describe('WS bootstrap recent-connect hybrid', () => {
  function metricStub() {
    return { inc: jest.fn(), observe: jest.fn() };
  }

  function buildHarnessWithRealSubscribe(opts: {
    markChannelRecentConnect: jest.Mock;
    invalidateRecentConnectTargetsCache: jest.Mock;
    ensureRedisChannelSubscribed?: jest.Mock;
  }) {
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
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'good1' }, { id: 'bad2' }] });
    const ensureRedisChannelSubscribed =
      opts.ensureRedisChannelSubscribed ||
      jest.fn().mockImplementation(async (ch: string) => {
        if (ch === 'channel:bad2') throw new Error('subscribe failed');
      });
    const { subscribeClient } = createSubscriptionManager({
      localUserClients: new Map(),
      channelClients: new Map(),
      communityClients: new Map(),
      userIdFromTarget: (ch: string) => (ch.startsWith('user:') ? ch.slice('user:'.length) : null),
      ready: jest.fn().mockResolvedValue(undefined),
      ensureRedisChannelSubscribed,
      releaseRedisChannelSubscription: jest.fn(),
      markChannelRecentConnect: opts.markChannelRecentConnect,
      invalidateRecentConnectTargetsCache: opts.invalidateRecentConnectTargetsCache,
    });
    const { bootstrapWithRetry, subscribeBootstrapChannel } = createBootstrapSubscriptionsHelpers({
      redis,
      isRedisOperational: () => true,
      query,
      logger: { warn: jest.fn() },
      staleCacheKey: (k: string) => `stale:${k}`,
      getJsonCache: jest.fn().mockResolvedValue(null),
      setJsonCacheWithStale: jest.fn().mockResolvedValue(undefined),
      withDistributedSingleflight: jest.requireMock('../src/utils/distributedSingleflight')
        .withDistributedSingleflight,
      wsBootstrapIngressKey: (uid: string, scope: string) => `ingress:${uid}:${scope}`,
      readWsBootstrapIngressCacheBase: jest.fn().mockResolvedValue(null),
      writeWsBootstrapIngressCacheBase: jest.fn().mockResolvedValue(undefined),
      resolvedWsRuntimeConfig: () => ({ autoSubscribeMode: 'full' }),
      warmWsAclCacheFromChannelList: jest.fn(),
      markChannelRecentConnect: opts.markChannelRecentConnect,
      invalidateRecentConnectTargetsCache: opts.invalidateRecentConnectTargetsCache,
      subscribeClient,
      subscribeCommunityClient: jest.fn(),
      parseChannelKey,
      wsBootstrapListCacheTotal: metricStub(),
      wsBootstrapChannelsHistogram: metricStub(),
      wsBootstrapBlockedTotal: metricStub(),
      wsBootstrapCachedTotal: metricStub(),
      wsBootstrapDbTotal: metricStub(),
      wsBootstrapWallDurationMs: metricStub(),
      WS_BOOTSTRAP_INGRESS_TTL_SECONDS: 60,
      WS_BOOTSTRAP_DB_MAX_IN_FLIGHT: 8,
      WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS: 20,
      WS_BOOTSTRAP_CACHE_TTL_SECONDS: 60,
      WS_BOOTSTRAP_BATCH_SIZE: 96,
    });
    return { redis, query, subscribeClient, bootstrapWithRetry, subscribeBootstrapChannel };
  }

  it('bulk primes both channels before subscribe; subscribeClient skips duplicate mark/invalidate for primed good1', async () => {
    const markRecent = jest.fn().mockResolvedValue(undefined);
    const invalidateRecent = jest.fn().mockResolvedValue(undefined);
    const { bootstrapWithRetry } = buildHarnessWithRealSubscribe({
      markChannelRecentConnect: markRecent,
      invalidateRecentConnectTargetsCache: invalidateRecent,
    });
    const ws = { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-1' } as any;
    await bootstrapWithRetry(ws, 'user-1');
    expect(markRecent).toHaveBeenCalledTimes(2);
    expect(markRecent).toHaveBeenCalledWith('user-1', 'good1');
    expect(markRecent).toHaveBeenCalledWith('user-1', 'bad2');
    expect(invalidateRecent).toHaveBeenCalledTimes(2);
    expect(ws._bootstrapRecentConnectChannelIds).toBeUndefined();
  });

  it('bulk prime still ZSET-marks a channel whose subscribeClient later fails (bad2)', async () => {
    const markRecent = jest.fn().mockResolvedValue(undefined);
    const invalidateRecent = jest.fn().mockResolvedValue(undefined);
    const { bootstrapWithRetry } = buildHarnessWithRealSubscribe({
      markChannelRecentConnect: markRecent,
      invalidateRecentConnectTargetsCache: invalidateRecent,
    });
    const ws = { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-1' } as any;
    await bootstrapWithRetry(ws, 'user-1');
    expect(markRecent).toHaveBeenCalledWith('user-1', 'bad2');
    expect(ws._subscriptions.has('channel:bad2')).toBe(false);
  });

  it('when bulk mark fails for a channel, subscribeClient still runs mark+invalidate on successful subscribe', async () => {
    let bad2MarkCalls = 0;
    const markRecent = jest.fn().mockImplementation(async (uid: string, id: string) => {
      if (id === 'bad2') {
        bad2MarkCalls += 1;
        if (bad2MarkCalls === 1) throw new Error('bulk mark failed');
      }
    });
    const invalidateRecent = jest.fn().mockResolvedValue(undefined);
    const ensureRedis = jest.fn().mockResolvedValue(undefined);
    const { bootstrapWithRetry } = buildHarnessWithRealSubscribe({
      markChannelRecentConnect: markRecent,
      invalidateRecentConnectTargetsCache: invalidateRecent,
      ensureRedisChannelSubscribed: ensureRedis,
    });
    const ws = { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-1' } as any;
    await bootstrapWithRetry(ws, 'user-1');
    expect(markRecent).toHaveBeenCalledWith('user-1', 'good1');
    expect(bad2MarkCalls).toBe(2);
    expect(ws._subscriptions.has('channel:bad2')).toBe(true);
  });
  it('client subscribeBootstrapChannel without primed set still triggers mark+invalidate', async () => {
    const markRecent = jest.fn().mockResolvedValue(undefined);
    const invalidateRecent = jest.fn().mockResolvedValue(undefined);
    const { subscribeBootstrapChannel } = buildHarnessWithRealSubscribe({
      markChannelRecentConnect: markRecent,
      invalidateRecentConnectTargetsCache: invalidateRecent,
    });
    const ws = { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-2' } as any;
    await subscribeBootstrapChannel(ws, 'channel:manual');
    await new Promise<void>((r) => setImmediate(r));
    expect(markRecent).toHaveBeenCalledWith('user-2', 'manual');
    expect(invalidateRecent).toHaveBeenCalledWith('manual');
  });
});

describe('subscriptionManager subscribeClient recent-connect', () => {
  it('marks recent connect once per new channel subscribe (fire-and-forget)', async () => {
    const markChannelRecentConnect = jest.fn().mockResolvedValue(undefined);
    const invalidateRecentConnectTargetsCache = jest.fn().mockResolvedValue(undefined);
    const ensureRedisChannelSubscribed = jest.fn().mockResolvedValue(undefined);
    const { subscribeClient } = createSubscriptionManager({
      localUserClients: new Map(),
      channelClients: new Map(),
      communityClients: new Map(),
      userIdFromTarget: (ch: string) => {
        if (ch.startsWith('user:')) return ch.slice('user:'.length);
        return null;
      },
      ready: jest.fn().mockResolvedValue(undefined),
      ensureRedisChannelSubscribed,
      releaseRedisChannelSubscription: jest.fn(),
      markChannelRecentConnect,
      invalidateRecentConnectTargetsCache,
    });
    const ws = {
      readyState: 1,
      _subscriptions: new Set<string>(),
      _userId: 'u9',
      _explicitChannelUnsub: new Set<string>(),
    };
    await subscribeClient(ws, 'channel:abc');
    await new Promise<void>((r) => setImmediate(r));
    expect(markChannelRecentConnect).toHaveBeenCalledTimes(1);
    expect(markChannelRecentConnect).toHaveBeenCalledWith('u9', 'abc');
    expect(invalidateRecentConnectTargetsCache).toHaveBeenCalledWith('abc');
    await subscribeClient(ws, 'channel:abc');
    await new Promise<void>((r) => setImmediate(r));
    expect(markChannelRecentConnect).toHaveBeenCalledTimes(1);
  });

  it('skips mark and invalidate when channel id is bootstrap-primed', async () => {
    const markChannelRecentConnect = jest.fn().mockResolvedValue(undefined);
    const invalidateRecentConnectTargetsCache = jest.fn().mockResolvedValue(undefined);
    const { subscribeClient } = createSubscriptionManager({
      localUserClients: new Map(),
      channelClients: new Map(),
      communityClients: new Map(),
      userIdFromTarget: (ch: string) => (ch.startsWith('user:') ? ch.slice('user:'.length) : null),
      ready: jest.fn().mockResolvedValue(undefined),
      ensureRedisChannelSubscribed: jest.fn().mockResolvedValue(undefined),
      releaseRedisChannelSubscription: jest.fn(),
      markChannelRecentConnect,
      invalidateRecentConnectTargetsCache,
    });
    const ws = {
      readyState: 1,
      _subscriptions: new Set<string>(),
      _userId: 'u9',
      _explicitChannelUnsub: new Set<string>(),
      _bootstrapRecentConnectChannelIds: new Set<string>(['abc']),
    };
    await subscribeClient(ws, 'channel:abc');
    await new Promise<void>((r) => setImmediate(r));
    expect(markChannelRecentConnect).not.toHaveBeenCalled();
    expect(invalidateRecentConnectTargetsCache).not.toHaveBeenCalled();
  });
});

describe('primeBootstrapChannelRecentConnect ZSCORE precheck', () => {
  const NOW = Date.now();
  const RECENT_SCORE = String(NOW);
  const STALE_SCORE = String(NOW - 70_000);

  function metricStub() {
    return { inc: jest.fn(), observe: jest.fn() };
  }

  function buildPrecheckHarness(opts: {
    channels: string[];
    channelScores?: Record<string, string | null>;
    pipelineError?: boolean;
    markChannelRecentConnect?: jest.Mock;
    invalidateRecentConnectTargetsCache?: jest.Mock;
  }) {
    const markRecent = opts.markChannelRecentConnect ?? jest.fn().mockResolvedValue(undefined);
    const invalidateRecent =
      opts.invalidateRecentConnectTargetsCache ?? jest.fn().mockResolvedValue(undefined);

    const pipelineFactory = () => {
      const queued: Array<{ key: string }> = [];
      return {
        zscore: jest.fn().mockImplementation((key: string) => {
          queued.push({ key });
        }),
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockImplementation(async () => {
          if (opts.pipelineError) throw new Error('Redis pipeline error');
          return queued.map(({ key }) => {
            const channelId = key.replace('channel:recent_connect:', '');
            const score = opts.channelScores?.[channelId] ?? null;
            return [null, score];
          });
        }),
      };
    };

    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      unlink: jest.fn().mockResolvedValue(0),
      pipeline: jest.fn().mockImplementation(pipelineFactory),
    };

    const { parseChannelKey } = require('../src/websocket/channelKeyParse');
    const { prepareBootstrapWithRetry } =
      require('../src/websocket/bootstrapSubscriptions').createBootstrapSubscriptionsHelpers({
        redis,
        isRedisOperational: () => true,
        query: jest.fn(),
        logger: { warn: jest.fn() },
        staleCacheKey: (k: string) => `stale:${k}`,
        getJsonCache: jest.fn().mockResolvedValue(opts.channels),
        setJsonCacheWithStale: jest.fn().mockResolvedValue(undefined),
        withDistributedSingleflight: jest.fn(
          async ({ load }: { load: () => Promise<unknown> }) => load(),
        ),
        wsBootstrapIngressKey: (uid: string, scope: string) => `ingress:${uid}:${scope}`,
        readWsBootstrapIngressCacheBase: jest.fn().mockResolvedValue(null),
        writeWsBootstrapIngressCacheBase: jest.fn().mockResolvedValue(undefined),
        resolvedWsRuntimeConfig: () => ({ autoSubscribeMode: 'full' }),
        warmWsAclCacheFromChannelList: jest.fn(),
        markChannelRecentConnect: markRecent,
        invalidateRecentConnectTargetsCache: invalidateRecent,
        subscribeClient: jest.fn().mockResolvedValue(undefined),
        subscribeCommunityClient: jest.fn(),
        parseChannelKey,
        wsBootstrapListCacheTotal: metricStub(),
        wsBootstrapChannelsHistogram: metricStub(),
        wsBootstrapBlockedTotal: metricStub(),
        wsBootstrapCachedTotal: metricStub(),
        wsBootstrapDbTotal: metricStub(),
        wsBootstrapWallDurationMs: metricStub(),
        WS_BOOTSTRAP_INGRESS_TTL_SECONDS: 60,
        WS_BOOTSTRAP_DB_MAX_IN_FLIGHT: 8,
        WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS: 20,
        WS_BOOTSTRAP_CACHE_TTL_SECONDS: 60,
        WS_BOOTSTRAP_BATCH_SIZE: 96,
      });

    return { markRecent, invalidateRecent, prepareBootstrapWithRetry };
  }

  it('fresh connect: marks and invalidates all channels when no ZSCORE exists', async () => {
    const { markRecent, invalidateRecent, prepareBootstrapWithRetry } = buildPrecheckHarness({
      channels: ['channel:ch1', 'channel:ch2'],
      channelScores: {},
    });
    const ws = { readyState: 1 } as any;
    await prepareBootstrapWithRetry(ws, 'u1');
    expect(markRecent).toHaveBeenCalledTimes(2);
    expect(markRecent).toHaveBeenCalledWith('u1', 'ch1');
    expect(markRecent).toHaveBeenCalledWith('u1', 'ch2');
    expect(invalidateRecent).toHaveBeenCalledTimes(2);
  });

  it('reconnect: skips mark and invalidation when all scores are within TTL', async () => {
    const { markRecent, invalidateRecent, prepareBootstrapWithRetry } = buildPrecheckHarness({
      channels: ['channel:ch1', 'channel:ch2'],
      channelScores: { ch1: RECENT_SCORE, ch2: RECENT_SCORE },
    });
    const ws = { readyState: 1 } as any;
    await prepareBootstrapWithRetry(ws, 'u1');
    expect(markRecent).not.toHaveBeenCalled();
    expect(invalidateRecent).not.toHaveBeenCalled();
  });

  it('partial reconnect: only marks and invalidates channels with missing or stale scores', async () => {
    const { markRecent, invalidateRecent, prepareBootstrapWithRetry } = buildPrecheckHarness({
      channels: ['channel:ch1', 'channel:ch2', 'channel:ch3'],
      channelScores: { ch1: RECENT_SCORE, ch2: RECENT_SCORE },
    });
    const ws = { readyState: 1 } as any;
    await prepareBootstrapWithRetry(ws, 'u1');
    expect(markRecent).toHaveBeenCalledTimes(1);
    expect(markRecent).toHaveBeenCalledWith('u1', 'ch3');
    expect(markRecent).not.toHaveBeenCalledWith('u1', 'ch1');
    expect(markRecent).not.toHaveBeenCalledWith('u1', 'ch2');
    expect(invalidateRecent).toHaveBeenCalledTimes(1);
    expect(invalidateRecent).toHaveBeenCalledWith('ch3');
  });

  it('pipeline failure: falls back to marking all channels', async () => {
    const { markRecent, invalidateRecent, prepareBootstrapWithRetry } = buildPrecheckHarness({
      channels: ['channel:ch1', 'channel:ch2'],
      channelScores: { ch1: RECENT_SCORE, ch2: RECENT_SCORE },
      pipelineError: true,
    });
    const ws = { readyState: 1 } as any;
    await prepareBootstrapWithRetry(ws, 'u1');
    expect(markRecent).toHaveBeenCalledTimes(2);
    expect(invalidateRecent).toHaveBeenCalledTimes(2);
  });

  it('stale score outside TTL window is treated as missing and gets marked', async () => {
    const { markRecent, invalidateRecent, prepareBootstrapWithRetry } = buildPrecheckHarness({
      channels: ['channel:ch1'],
      channelScores: { ch1: STALE_SCORE },
    });
    const ws = { readyState: 1 } as any;
    await prepareBootstrapWithRetry(ws, 'u1');
    expect(markRecent).toHaveBeenCalledTimes(1);
    expect(markRecent).toHaveBeenCalledWith('u1', 'ch1');
    expect(invalidateRecent).toHaveBeenCalledTimes(1);
  });

  it('progressive-ready safety: new channel with no score is primed and recorded in primed set', async () => {
    // User was recently subscribed to ch1/ch2 (scores within TTL) but has since
    // joined ch3 (no score). ch3 must be marked before hydration begins so
    // channel fanout can route to the user during the progressive-ready bridge window.
    const { markRecent, prepareBootstrapWithRetry } = buildPrecheckHarness({
      channels: ['channel:ch1', 'channel:ch2', 'channel:ch3'],
      channelScores: { ch1: RECENT_SCORE, ch2: RECENT_SCORE },
    });
    const ws = { readyState: 1 } as any;
    await prepareBootstrapWithRetry(ws, 'u1');
    expect(markRecent).toHaveBeenCalledTimes(1);
    expect(markRecent).toHaveBeenCalledWith('u1', 'ch3');
    expect(ws._bootstrapRecentConnectChannelIds?.has('ch1')).toBe(true);
    expect(ws._bootstrapRecentConnectChannelIds?.has('ch2')).toBe(true);
    expect(ws._bootstrapRecentConnectChannelIds?.has('ch3')).toBe(true);
  });
});
