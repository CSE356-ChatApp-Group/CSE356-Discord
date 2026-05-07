jest.mock('../src/websocket/fanout', () => {
  const pub = jest.fn(() => Promise.resolve()) as unknown as jest.MockedFunction<
    (channel: string, payload: unknown) => Promise<void>
  >;
  const batch = jest.fn(async (entries: Array<{ channel: string; payload: unknown }>) => {
    for (const e of entries) {
      await pub(e.channel, e.payload);
    }
  });
  return { publish: pub, publishBatch: batch };
});

jest.mock('../src/db/redis', () => ({
  pipeline: jest.fn(() => {
    const ops: string[] = [];
    return {
      hkeys: jest.fn(function hkeys(this: any, key: string) {
        ops.push(key);
        return this;
      }),
      smembers: jest.fn(function smembers(this: any, key: string) {
        ops.push(`smembers:${key}`);
        return this;
      }),
      exists: jest.fn(function exists(this: any, key: string) {
        ops.push(`exists:${key}`);
        return this;
      }),
      get: jest.fn(function get(this: any, key: string) {
        ops.push(`get:${key}`);
        return this;
      }),
      exec: jest.fn(async () => ops.map(() => [{}, []])),
    };
  }),
}));

const fanout = require('../src/websocket/fanout') as { publish: jest.Mock; publishBatch: jest.Mock };
const redis = require('../src/db/redis') as { pipeline: jest.Mock };
const {
  publishUserFeedTargets,
  runWithConcurrencyLimit,
  splitUserTargets,
  userFeedRedisChannelForUserId,
  userFeedWorkerChannelForOwner,
} = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: (
    targets: string[],
    payload: Record<string, unknown>,
    options?: { preferLiveOwners?: boolean },
  ) => Promise<void>;
  runWithConcurrencyLimit: (jobs: Array<() => Promise<void>>, limit: number) => Promise<void>;
  splitUserTargets: (targets: string[]) => { userIds: string[]; passthroughTargets: string[] };
  userFeedRedisChannelForUserId: (userId: string) => string;
  userFeedWorkerChannelForOwner: (ownerId: string) => string;
};

function pickUserIdsForDistinctShardChannels(minCount: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; out.length < minCount && i < 500_000; i += 1) {
    const id = `uid${i}`;
    const ch = userFeedRedisChannelForUserId(id);
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(id);
  }
  if (out.length < minCount) {
    throw new Error(`need ${minCount} distinct userfeed shards, got ${out.length}`);
  }
  return out;
}

describe('userFeed', () => {
  afterEach(() => {
    fanout.publish.mockReset();
    fanout.publish.mockResolvedValue(undefined);
    fanout.publishBatch.mockReset();
    fanout.publishBatch.mockImplementation(async (entries) => {
      for (const e of entries) {
        await fanout.publish(e.channel, e.payload);
      }
    });
    redis.pipeline.mockReset();
    redis.pipeline.mockImplementation(() => {
      const ops: string[] = [];
      return {
        hkeys: jest.fn(function hkeys(this: any, key: string) {
          ops.push(key);
          return this;
        }),
        smembers: jest.fn(function smembers(this: any, key: string) {
          ops.push(`smembers:${key}`);
          return this;
        }),
        exists: jest.fn(function exists(this: any, key: string) {
          ops.push(`exists:${key}`);
          return this;
        }),
        get: jest.fn(function get(this: any, key: string) {
          ops.push(`get:${key}`);
          return this;
        }),
        exec: jest.fn(async () => ops.map(() => [{}, []])),
      };
    });
  });

  it('splitUserTargets separates user ids from passthrough targets', () => {
    expect(
      splitUserTargets([
        'user:a',
        'conversation:1',
        'user:b',
        'community:1',
        'user:a',
      ]),
    ).toEqual({
      userIds: ['a', 'b'],
      passthroughTargets: ['conversation:1', 'community:1'],
    });
  });

  it('publishUserFeedTargets groups recipients by shard feed', async () => {
    const users = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const expectedGroups = new Map<string, string[]>();
    for (const userId of users) {
      const channel = userFeedRedisChannelForUserId(userId);
      if (!expectedGroups.has(channel)) expectedGroups.set(channel, []);
      expectedGroups.get(channel)!.push(userId);
    }

    await publishUserFeedTargets(users.map((userId) => `user:${userId}`), {
      event: 'message:created',
      data: { id: 'm1' },
    });

    expect(fanout.publishBatch).toHaveBeenCalledTimes(1);
    const batch = fanout.publishBatch.mock.calls[0][0] as Array<{
      channel: string;
      payload: { __wsRoute: { userIds: string[] }; payload: { event: string; data: { id: string } } };
    }>;
    expect(batch.length).toBe(expectedGroups.size);
    const actualGroups = new Map<string, string[]>();
    for (const { channel, payload: envelope } of batch) {
      actualGroups.set(channel, envelope.__wsRoute.userIds);
      expect(envelope.payload.event).toBe('message:created');
      expect(envelope.payload.data.id).toBe('m1');
    }
    expect(actualGroups).toEqual(expectedGroups);
  });

  it('publishUserFeedTargets prefers worker-owned channels and falls back to shard feeds', async () => {
    redis.pipeline
      .mockImplementationOnce(() => {
        const ops: string[] = [];
        return {
          smembers: jest.fn(function smembers(this: any, key: string) {
            ops.push(key);
            return this;
          }),
          exec: jest.fn(async () => ops.map((key) => {
            if (key.includes('alpha')) return [{}, ['c1']];
            if (key.includes('beta')) return [{}, ['c2', 'c3']];
            return [{}, []];
          })),
        };
      })
      .mockImplementationOnce(() => {
        const ops: string[] = [];
        return {
          exists: jest.fn(function exists(this: any, key: string) {
            ops.push(`exists:${key}`);
            return this;
          }),
          get: jest.fn(function get(this: any, key: string) {
            ops.push(`get:${key}`);
            return this;
          }),
          exec: jest.fn(async () => ops.map((key) => {
            if (key.startsWith('exists:') && key.includes('alpha') && key.includes(':alive')) return [{}, 1];
            if (key.startsWith('get:') && key.includes('alpha') && key.includes(':owner')) return [{}, 'vm2:4001'];
            if (key.startsWith('exists:') && key.includes('beta') && key.includes('c2:alive')) return [{}, 1];
            if (key.startsWith('get:') && key.includes('beta') && key.includes('c2:owner')) return [{}, 'vm2:4001'];
            if (key.startsWith('exists:') && key.includes('beta') && key.includes('c3:alive')) return [{}, 1];
            if (key.startsWith('get:') && key.includes('beta') && key.includes('c3:owner')) return [{}, 'vm3:4004'];
            return [{}, null];
          })),
        };
      });

    await publishUserFeedTargets(['user:alpha', 'user:beta', 'user:gamma'], {
      event: 'message:created',
      data: { id: 'm-worker' },
    });

    expect(fanout.publishBatch).toHaveBeenCalledTimes(1);
    const batch = fanout.publishBatch.mock.calls[0][0] as Array<{
      channel: string;
      payload: { __wsRoute: { userIds: string[] } };
    }>;
    const groups = new Map(batch.map((entry) => [entry.channel, entry.payload.__wsRoute.userIds]));
    expect(groups.get(userFeedWorkerChannelForOwner('vm2:4001'))).toEqual(['alpha', 'beta']);
    expect(groups.get(userFeedWorkerChannelForOwner('vm3:4004'))).toEqual(['beta']);
    expect(groups.get(userFeedRedisChannelForUserId('gamma'))).toEqual(['gamma']);
  });

  it('publishUserFeedTargets can prefer only live worker owners for exact direct fanout', async () => {
    redis.pipeline
      .mockImplementationOnce(() => {
        const ops: string[] = [];
        return {
          smembers: jest.fn(function smembers(this: any, key: string) {
            ops.push(key);
            return this;
          }),
          exec: jest.fn(async () => ops.map((key) => {
            if (key.includes('alpha')) return [{}, ['c1']];
            if (key.includes('beta')) return [{}, ['c2']];
            return [{}, []];
          })),
        };
      })
      .mockImplementationOnce(() => {
        const ops: string[] = [];
        return {
          exists: jest.fn(function exists(this: any, key: string) {
            ops.push(`exists:${key}`);
            return this;
          }),
          get: jest.fn(function get(this: any, key: string) {
            ops.push(`get:${key}`);
            return this;
          }),
          exec: jest.fn(async () => ops.map((key) => {
            if (key.startsWith('exists:') && key.includes('alpha') && key.includes(':alive')) return [{}, 1];
            if (key.startsWith('get:') && key.includes('alpha') && key.includes(':owner')) return [{}, 'vm2:4005'];
            if (key.startsWith('exists:') && key.includes('beta') && key.includes(':alive')) return [{}, 0];
            if (key.startsWith('get:') && key.includes('beta') && key.includes(':owner')) return [{}, 'vm3:4004'];
            return [{}, null];
          })),
        };
      });

    await publishUserFeedTargets(['user:alpha', 'user:beta'], {
      event: 'message:created',
      data: { id: 'm-live-worker' },
    }, {
      preferLiveOwners: true,
    });

    expect(fanout.publishBatch).toHaveBeenCalledTimes(1);
    const batch = fanout.publishBatch.mock.calls[0][0] as Array<{
      channel: string;
      payload: { __wsRoute: { userIds: string[] } };
    }>;
    const groups = new Map(batch.map((entry) => [entry.channel, entry.payload.__wsRoute.userIds]));
    expect(groups.get(userFeedWorkerChannelForOwner('vm2:4005'))).toEqual(['alpha']);
    expect(groups.get(userFeedRedisChannelForUserId('beta'))).toEqual(['beta']);
    expect(groups.has(userFeedWorkerChannelForOwner('vm3:4004'))).toBe(false);
  });

  it('publishUserFeedTargets automatically prefers live owners for small fanouts', async () => {
    redis.pipeline
      .mockImplementationOnce(() => {
        const ops: string[] = [];
        return {
          smembers: jest.fn(function smembers(this: any, key: string) {
            ops.push(key);
            return this;
          }),
          exec: jest.fn(async () => ops.map((key) => {
            if (key.includes('alpha')) return [{}, ['c1']];
            return [{}, []];
          })),
        };
      })
      .mockImplementationOnce(() => {
        const ops: string[] = [];
        return {
          exists: jest.fn(function exists(this: any, key: string) {
            ops.push(`exists:${key}`);
            return this;
          }),
          get: jest.fn(function get(this: any, key: string) {
            ops.push(`get:${key}`);
            return this;
          }),
          exec: jest.fn(async () => ops.map((key) => {
            if (key.startsWith('exists:') && key.includes('alpha') && key.includes(':alive')) return [{}, 1];
            if (key.startsWith('get:') && key.includes('alpha') && key.includes(':owner')) return [{}, 'vm1:4002'];
            return [{}, null];
          })),
        };
      });

    await publishUserFeedTargets(['user:alpha'], {
      event: 'presence:updated',
      data: { userId: 'alpha', status: 'away' },
    });

    expect(fanout.publishBatch).toHaveBeenCalledTimes(1);
    const batch = fanout.publishBatch.mock.calls[0][0] as Array<{
      channel: string;
      payload: { __wsRoute: { userIds: string[] } };
    }>;
    expect(batch).toHaveLength(1);
    expect(batch[0].channel).toBe(userFeedWorkerChannelForOwner('vm1:4002'));
    expect(batch[0].payload.__wsRoute.userIds).toEqual(['alpha']);
  });

  it('runWithConcurrencyLimit never exceeds the limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jobs = Array.from({ length: 12 }, () => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    await runWithConcurrencyLimit(jobs, 2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('publishUserFeedTargets batches one publishBatch with one entry per distinct shard', async () => {
    const userIds = pickUserIdsForDistinctShardChannels(10);
    await publishUserFeedTargets(
      userIds.map((u) => `user:${u}`),
      { event: 'message:created', data: { id: 'm2' } },
    );

    expect(fanout.publishBatch).toHaveBeenCalledTimes(1);
    const batch = fanout.publishBatch.mock.calls[0][0] as Array<{ channel: string }>;
    expect(batch.length).toBe(10);
    const channels = batch.map((c) => c.channel);
    expect(new Set(channels).size).toBe(10);
  });

  it('publishUserFeedTargets propagates fanout.publishBatch errors', async () => {
    fanout.publishBatch.mockRejectedValueOnce(new Error('redis unavailable'));
    const userIds = pickUserIdsForDistinctShardChannels(3);
    await expect(
      publishUserFeedTargets(userIds.map((u) => `user:${u}`), {
        event: 'message:created',
        data: { id: 'm3' },
      }),
    ).rejects.toThrow('redis unavailable');
  });
});
