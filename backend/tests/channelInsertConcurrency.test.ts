function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeRedisLockClient {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private purgeExpired(key: string) {
    const entry = this.store.get(key);
    if (!entry) return;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }

  async set(key: string, value: string, ...args: any[]) {
    this.purgeExpired(key);
    let onlyIfMissing = false;
    let ttlMs: number | null = null;

    for (let i = 0; i < args.length; i += 1) {
      const token = String(args[i]).toUpperCase();
      if (token === 'NX') {
        onlyIfMissing = true;
      } else if (token === 'PX') {
        ttlMs = Number(args[i + 1]);
        i += 1;
      } else if (token === 'EX') {
        ttlMs = Number(args[i + 1]) * 1000;
        i += 1;
      }
    }

    if (onlyIfMissing && this.store.has(key)) return null;

    this.store.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
    return 'OK';
  }

  async eval(_script: string, _numKeys: number, key: string, token: string) {
    this.purgeExpired(key);
    const entry = this.store.get(key);
    if (!entry || entry.value !== token) return 0;
    this.store.delete(key);
    return 1;
  }

  async incr(key: string) {
    this.purgeExpired(key);
    const entry = this.store.get(key);
    const current = entry ? Number(entry.value) || 0 : 0;
    const next = current + 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? null,
    });
    return next;
  }

  async decr(key: string) {
    this.purgeExpired(key);
    const entry = this.store.get(key);
    const current = entry ? Number(entry.value) || 0 : 0;
    const next = current - 1;
    if (next <= 0) {
      this.store.delete(key);
      return 0;
    }
    this.store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? null,
    });
    return next;
  }

  async pexpire(key: string, ttlMs: number) {
    this.purgeExpired(key);
    const entry = this.store.get(key);
    if (!entry) return 0;
    this.store.set(key, {
      value: entry.value,
      expiresAt: Date.now() + Number(ttlMs),
    });
    return 1;
  }
}

class ThrowingRedisLockClient extends FakeRedisLockClient {
  override async set(
    _key: string,
    _value: string,
    ..._args: any[]
  ): Promise<string> {
    throw new Error('redis down');
  }
}

class SlowReleaseRedisLockClient extends FakeRedisLockClient {
  constructor(private readonly delayMs: number) {
    super();
  }

  override async eval(
    _script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<0 | 1> {
    await sleep(this.delayMs);
    return super.eval(_script, _numKeys, key, token);
  }
}

function withEnv(env: Record<string, string>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function loadWorker(
  redisClient: FakeRedisLockClient,
  env: Record<string, string> = {},
) {
  const metrics = {
    messageChannelInsertLockTotal: { inc: jest.fn() },
    messageChannelInsertLockWaitMs: { observe: jest.fn() },
    messageInsertLockWaitersCurrentGauge: { set: jest.fn() },
    messageInsertLockQueueRejectTotal: { inc: jest.fn() },
    messageInsertLockWaitTimeoutTotal: { inc: jest.fn() },
    messageInsertLockAcquiredAfterWaitTotal: { inc: jest.fn() },
    messageInsertLockHolderDurationMs: { observe: jest.fn() },
  };
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  let loaded: any;

  withEnv(env, () => {
    jest.isolateModules(() => {
      jest.doMock('../src/db/redis', () => redisClient);
      jest.doMock('../src/utils/logger', () => logger);
      jest.doMock('../src/utils/metrics', () => metrics);
      jest.doMock('../src/messages/messageInsertLockPressure', () => ({
        recordMessageChannelInsertLockAcquireWait: jest.fn(),
        recordMessageChannelInsertLockTimeoutEvent: jest.fn(),
        getShouldDeferReadReceiptForInsertLockPressure: jest.fn().mockReturnValue(false),
      }));
      loaded = require('../src/messages/channelInsertConcurrency');
    });
  });

  return {
    ...loaded,
    logger,
    metrics,
  };
}

describe('runChannelMessageInsertSerialized', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.unmock('../src/db/redis');
    jest.unmock('../src/utils/logger');
    jest.unmock('../src/utils/metrics');
    jest.unmock('../src/messages/messageInsertLockPressure');
    jest.resetModules();
  });

  it('runs immediately when channelId is null', async () => {
    const worker = loadWorker(new FakeRedisLockClient());
    let ran = false;

    await worker.runChannelMessageInsertSerialized(null, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it('serializes same-channel jobs across workers sharing Redis', async () => {
    const redisClient = new FakeRedisLockClient();
    const workerA = loadWorker(redisClient);
    const workerB = loadWorker(redisClient);
    const order: string[] = [];
    const ch = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    const p1 = workerA.runChannelMessageInsertSerialized(ch, async () => {
      order.push('a-start');
      await sleep(40);
      order.push('a-end');
    });
    await sleep(5);
    const p2 = workerB.runChannelMessageInsertSerialized(ch, async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await Promise.all([p1, p2]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('uses the default wait timeout around 2000ms', async () => {
    const redisClient = new FakeRedisLockClient();
    const workerA = loadWorker(redisClient);
    const workerB = loadWorker(redisClient);
    const ch = 'abababab-aaaa-bbbb-cccc-dddddddddddd';

    const p1 = workerA.runChannelMessageInsertSerialized(ch, async () => {
      await sleep(2200);
    });
    await sleep(10);
    await expect(
      workerB.runChannelMessageInsertSerialized(ch, async () => undefined),
    ).rejects.toMatchObject({
      code: 'MESSAGE_INSERT_LOCK_TIMEOUT',
      statusCode: 503,
      messagePostRetryCode: 'message_insert_lock_wait_timeout',
    });
    await p1;
  });

  it('does not serialize different channels across workers', async () => {
    const redisClient = new FakeRedisLockClient();
    const workerA = loadWorker(redisClient);
    const workerB = loadWorker(redisClient);
    const order: string[] = [];

    const pA = workerA.runChannelMessageInsertSerialized(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      async () => {
        order.push('a-start');
        await sleep(40);
        order.push('a-end');
      },
    );
    const pB = workerB.runChannelMessageInsertSerialized(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      async () => {
        order.push('b');
      },
    );

    await Promise.all([pA, pB]);

    expect(order).toContain('b');
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a-end'));
  });

  it('returns a retryable timeout when the lock cannot be acquired quickly', async () => {
    const redisClient = new FakeRedisLockClient();
    // MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS min is 500ms — Worker A must hold past that.
    // Use a manually-released promise so the lock is held until after Worker B times out.
    const env = {
      MESSAGE_INSERT_LOCK_TTL_MS: '6000',
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '500',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '10',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '10',
    };
    const workerA = loadWorker(redisClient, env);
    const workerB = loadWorker(redisClient, env);
    const ch = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    let releaseA!: () => void;
    const holdUntilReleased = new Promise<void>((resolve) => { releaseA = resolve; });
    const p1 = workerA.runChannelMessageInsertSerialized(ch, async () => {
      await holdUntilReleased;
    });
    await sleep(5);

    await expect(
      workerB.runChannelMessageInsertSerialized(ch, async () => 'never'),
    ).rejects.toMatchObject({
      code: 'MESSAGE_INSERT_LOCK_TIMEOUT',
      statusCode: 503,
      messagePostRetryCode: 'message_insert_lock_wait_timeout',
    });
    releaseA();
    await p1;

    expect(
      workerB.isChannelInsertLockTimeoutError(
        Object.assign(new Error('busy'), { code: 'MESSAGE_INSERT_LOCK_TIMEOUT' }),
      ),
    ).toBe(true);
  });

  it('suppresses immediate retries after a recent channel timeout', async () => {
    const redisClient = new FakeRedisLockClient();
    const env = {
      MESSAGE_INSERT_LOCK_TTL_MS: '6000',
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '500',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '10',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '10',
      MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS: '5000',
      MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS: '0',
      MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS: '0',
    };
    const workerA = loadWorker(redisClient, env);
    const workerB = loadWorker(redisClient, env);
    const ch = 'abababab-abcd-abcd-abcd-abababababab';

    let releaseA!: () => void;
    const holdUntilReleased = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const p1 = workerA.runChannelMessageInsertSerialized(ch, async () => {
      await holdUntilReleased;
    });
    await sleep(5);

    await expect(
      workerB.runChannelMessageInsertSerialized(ch, async () => 'never'),
    ).rejects.toMatchObject({
      code: 'MESSAGE_INSERT_LOCK_TIMEOUT',
      statusCode: 503,
      messagePostRetryCode: 'message_insert_lock_wait_timeout',
    });

    const retryStartedAt = Date.now();
    await expect(
      workerB.runChannelMessageInsertSerialized(ch, async () => 'retry-never'),
    ).rejects.toMatchObject({
      code: 'MESSAGE_INSERT_LOCK_TIMEOUT',
      statusCode: 503,
      messagePostRetryCode: 'message_insert_lock_recent_shed',
    });
    expect(Date.now() - retryStartedAt).toBeLessThan(150);

    releaseA();
    await p1;
    expect(workerB.metrics.messageChannelInsertLockTotal.inc).toHaveBeenCalledWith({
      result: 'recent_timeout_shed',
    });
  });

  it('fails safe when Redis is unavailable and still runs the insert locally', async () => {
    const worker = loadWorker(new ThrowingRedisLockClient());
    const fn = jest.fn(async () => 'ok');

    await expect(
      worker.runChannelMessageInsertSerialized(
        'abababab-abab-abab-abab-abababababab',
        fn,
        { requestId: 'req-redis-down' },
      ),
    ).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(worker.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'abababab-abab-abab-abab-abababababab',
        requestId: 'req-redis-down',
      }),
      'POST /messages channel insert lock Redis error; falling back to local serialization',
    );
  });

  it('rejects when per-channel waiter cap is exceeded', async () => {
    const redisClient = new FakeRedisLockClient();
    const env = {
      MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL: '2',
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '5000',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '10',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '10',
      MESSAGE_INSERT_LOCK_TTL_MS: '10000',
    };
    const worker = loadWorker(redisClient, env);
    const ch = '12121212-3434-5656-7878-909090909090';

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => { releaseA = resolve; });
    const p1 = worker.runChannelMessageInsertSerialized(ch, async () => {
      await holdA;
    });
    await sleep(5);

    let releaseB!: () => void;
    const holdB = new Promise<void>((resolve) => { releaseB = resolve; });
    const p2 = worker.runChannelMessageInsertSerialized(ch, async () => {
      await holdB;
      return 'b';
    });
    await sleep(25);

    await expect(
      worker.runChannelMessageInsertSerialized(ch, async () => 'c'),
    ).rejects.toMatchObject({
      code: 'MESSAGE_INSERT_LOCK_QUEUE_REJECT',
      statusCode: 503,
      messagePostRetryCode: 'message_insert_lock_waiter_cap',
    });

    releaseA();
    await p1;
    releaseB();
    await expect(p2).resolves.toBe('b');
    expect(worker.metrics.messageInsertLockQueueRejectTotal.inc).toHaveBeenCalled();
  });

  it('increments acquired-after-wait metric for queued waiters', async () => {
    const redisClient = new FakeRedisLockClient();
    const env = {
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '5000',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '10',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '10',
      MESSAGE_INSERT_LOCK_TTL_MS: '10000',
    };
    const worker = loadWorker(redisClient, env);
    const ch = '99999999-8888-7777-6666-555555555555';
    const order: string[] = [];

    const p1 = worker.runChannelMessageInsertSerialized(ch, async () => {
      order.push('a-start');
      await sleep(80);
      order.push('a-end');
      return 'a';
    });
    await sleep(5);
    const p2 = worker.runChannelMessageInsertSerialized(ch, async () => {
      order.push('b');
      return 'b';
    });

    await expect(Promise.all([p1, p2])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(worker.metrics.messageInsertLockAcquiredAfterWaitTotal.inc).toHaveBeenCalled();
  });

  it('reacquires after a stale lock expires', async () => {
    const redisClient = new FakeRedisLockClient();
    const worker = loadWorker(redisClient, {
      MESSAGE_INSERT_LOCK_TTL_MS: '40',
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '250',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '5',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '5',
    });
    const ch = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    await redisClient.set(`message_insert_lock:${ch}`, 'stale-token', 'PX', 40);
    const startedAt = Date.now();

    await worker.runChannelMessageInsertSerialized(ch, async () => undefined);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it("does not delete another worker's token on release", async () => {
    const redisClient = new FakeRedisLockClient();
    const env = {
      MESSAGE_INSERT_LOCK_TTL_MS: '40',
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '250',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '5',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '5',
    };
    const workerA = loadWorker(redisClient, env);
    const workerB = loadWorker(redisClient, env);
    const workerC = loadWorker(redisClient, env);
    const order: string[] = [];
    const ch = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    let resolveBStarted: (() => void) | null = null;
    const bStarted = new Promise<void>((resolve) => {
      resolveBStarted = resolve;
    });

    const p1 = workerA.runChannelMessageInsertSerialized(ch, async () => {
      order.push('a-start');
      await sleep(80);
      order.push('a-end');
    });
    await sleep(5);

    const p2 = workerB.runChannelMessageInsertSerialized(ch, async () => {
      order.push('b-start');
      resolveBStarted?.();
      await sleep(80);
      order.push('b-end');
    });
    await bStarted;

    const p3 = workerC.runChannelMessageInsertSerialized(ch, async () => {
      order.push('c-start');
      order.push('c-end');
    });

    await Promise.all([p1, p2, p3]);

    expect(order.indexOf('b-start')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('b-end'));
    expect(order.indexOf('c-start')).toBeGreaterThan(order.indexOf('b-end'));
  });

  it('continues local same-worker chain after rejection', async () => {
    const worker = loadWorker(new FakeRedisLockClient());
    const ch = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const order: string[] = [];

    try {
      await worker.runChannelMessageInsertSerialized(ch, async () => {
        order.push('a');
        throw new Error('fail');
      });
    } catch (e: any) {
      expect(e?.message).toBe('fail');
    }

    await worker.runChannelMessageInsertSerialized(ch, async () => {
      order.push('b');
    });

    expect(order).toEqual(['a', 'b']);
  });

  it('releases promptly when Redis lock release is slow', async () => {
    const worker = loadWorker(new SlowReleaseRedisLockClient(1500), {
      MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS: '50',
      MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS: '1000',
      MESSAGE_INSERT_LOCK_POLL_MIN_MS: '5',
      MESSAGE_INSERT_LOCK_POLL_MAX_MS: '5',
    });
    const ch = 'ababcdcd-abcd-abcd-abcd-abcdabcdabcd';
    const startedAt = Date.now();
    await worker.runChannelMessageInsertSerialized(ch, async () => {
      await sleep(10);
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(500);
    expect(worker.metrics.messageChannelInsertLockTotal.inc).toHaveBeenCalledWith({
      result: 'release_error',
    });
  });
});
