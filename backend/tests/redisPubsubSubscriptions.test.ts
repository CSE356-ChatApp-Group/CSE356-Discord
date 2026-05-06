jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('redis pubsub subscription topics', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...previousEnv };
  });

  function loadRedisModule() {
    const instances: any[] = [];

    class RedisMock {
      static Cluster = jest.fn((nodes, options) => new RedisMock(nodes, options));

      on = jest.fn();
      subscribe = jest.fn(() => Promise.resolve('subscribed'));
      unsubscribe = jest.fn(() => Promise.resolve('unsubscribed'));
      ssubscribe = jest.fn(() => Promise.resolve('ssubscribed'));
      sunsubscribe = jest.fn(() => Promise.resolve('sunsubscribed'));
      quit = jest.fn(() => Promise.resolve());

      constructor(public urlOrNodes?: unknown, public options?: unknown) {
        instances.push(this);
      }
    }

    jest.doMock('ioredis', () => RedisMock);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const redisModule = require('../src/db/redis');
    return { redisModule, instances, RedisMock };
  }

  it('standalone Redis subscribes direct channel and conversation topics', async () => {
    delete process.env.REDIS_CLUSTER_NODES;
    const { redisModule, instances } = loadRedisModule();
    const subscriber = instances[3];

    await redisModule.redisPubsubSubscribe('channel:chan-1');
    await redisModule.redisPubsubSubscribe('conversation:conv-1');
    redisModule.redisPubsubUnsubscribe('channel:chan-1');
    redisModule.redisPubsubUnsubscribe('conversation:conv-1');

    expect(subscriber.subscribe).toHaveBeenCalledWith('channel:chan-1');
    expect(subscriber.subscribe).toHaveBeenCalledWith('conversation:conv-1');
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('channel:chan-1');
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('conversation:conv-1');
  });

  it('standalone Redis keeps logical user topics on userfeed shards only', async () => {
    delete process.env.REDIS_CLUSTER_NODES;
    const { redisModule, instances } = loadRedisModule();
    const subscriber = instances[3];

    await redisModule.redisPubsubSubscribe('user:user-1');
    redisModule.redisPubsubUnsubscribe('user:user-1');

    expect(subscriber.subscribe).not.toHaveBeenCalled();
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
  });
});
