/**
 * WS bootstrap must not duplicate recent-connect Redis work: channel topics are marked
 * in subscribeClient (subscriptionManager) only after a successful local subscribe.
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

describe('WS bootstrap recent-connect marking', () => {
  function metricStub() {
    return { inc: jest.fn(), observe: jest.fn() };
  }

  function buildBootstrapHarness(opts: {
    subscribeClientImpl: (ws: any, ch: string) => Promise<void>;
  }) {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      unlink: jest.fn().mockResolvedValue(0),
      pipeline: () => ({
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'good1' }, { id: 'bad2' }] });
    const subscribeClient = jest.fn(opts.subscribeClientImpl) as jest.MockedFunction<
      (ws: any, ch: string) => Promise<void>
    >;
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

  it('subscribeClient marks each successful channel once (no separate bootstrap prefetch)', async () => {
    const subscribePathMark = jest.fn().mockResolvedValue(undefined);
    const subscribePathInvalidate = jest.fn().mockResolvedValue(undefined);

    const { subscribeClient, bootstrapWithRetry } = buildBootstrapHarness({
      subscribeClientImpl: async (ws: { _subscriptions: Set<string>; _userId: string }, ch: string) => {
        if (ws._subscriptions.has(ch)) return;
        if (ch === 'channel:bad2') throw new Error('subscribe failed');
        ws._subscriptions.add(ch);
        if (ch.startsWith('channel:')) {
          const id = ch.slice('channel:'.length);
          await subscribePathMark(ws._userId, id);
          await subscribePathInvalidate(id);
        }
      },
    });

    const ws = { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-1' };
    await bootstrapWithRetry(ws, 'user-1');

    expect(subscribePathMark).toHaveBeenCalledTimes(1);
    expect(subscribePathMark).toHaveBeenCalledWith('user-1', 'good1');
    expect(subscribeClient).toHaveBeenCalled();
  });

  it('subscribeBootstrapChannel + subscribeClient still covers client-driven subscribe path', async () => {
    const subscribePathMark = jest.fn().mockResolvedValue(undefined);
    const subscribePathInvalidate = jest.fn().mockResolvedValue(undefined);
    const { subscribeBootstrapChannel } = buildBootstrapHarness({
      subscribeClientImpl: async (ws: { _subscriptions: Set<string>; _userId: string }, ch: string) => {
        if (ws._subscriptions.has(ch)) return;
        ws._subscriptions.add(ch);
        if (ch.startsWith('channel:')) {
          const id = ch.slice('channel:'.length);
          await subscribePathMark(ws._userId, id);
          await subscribePathInvalidate(id);
        }
      },
    });
    const ws = { readyState: 1, _subscriptions: new Set<string>(), _userId: 'user-2' };
    await subscribeBootstrapChannel(ws, 'channel:manual');
    expect(subscribePathMark).toHaveBeenCalledWith('user-2', 'manual');
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
});
