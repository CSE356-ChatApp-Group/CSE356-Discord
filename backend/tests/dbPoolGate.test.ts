function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMetricsMock() {
  const counter = () => ({ inc: jest.fn() });
  const gauge = () => ({ set: jest.fn() });
  return {
    pgPoolCircuitBreakerRejectsTotal: counter(),
    pgPoolOperationErrorsTotal: counter(),
    pgQueryGateActive: gauge(),
    pgQueryGateWaiting: gauge(),
    pgQueryGateRejectsTotal: counter(),
  };
}

describe('db pool query gate', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      PG_QUERY_GATE_MAX_CONCURRENT: '1',
      PG_QUERY_GATE_MAX_WAITERS: '0',
      PG_QUERY_GATE_WAIT_TIMEOUT_MS: '50',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('rejects immediately when the query gate is saturated', async () => {
    const firstQuery = deferred<any>();
    const poolQuery = jest
      .fn()
      .mockImplementationOnce(() => firstQuery.promise)
      .mockResolvedValue({ rows: [] });
    const poolConnect = jest.fn();
    const metrics = makeMetricsMock();

    jest.doMock('pg', () => ({
      Pool: jest.fn(() => ({
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        query: poolQuery,
        connect: poolConnect,
        on: jest.fn(),
        end: jest.fn(),
      })),
    }));
    jest.doMock('../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
    jest.doMock('../src/utils/requestDbContext', () => ({ incrementDbQuery: jest.fn() }));
    jest.doMock('../src/utils/metrics', () => metrics);

    const dbPool = require('../src/db/pool') as {
      query: (sql: string, params?: any[]) => Promise<any>;
      queryGateStats: () => { active: number; waiting: number };
    };

    const inFlight = dbPool.query('SELECT 1');
    expect(dbPool.queryGateStats()).toMatchObject({ active: 1, waiting: 0 });

    await expect(dbPool.query('SELECT 2')).rejects.toMatchObject({
      code: 'PG_QUERY_GATE_SATURATED',
      statusCode: 503,
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);

    firstQuery.resolve({ rows: [] });
    await inFlight;
    expect(dbPool.queryGateStats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('holds the gate for checked-out clients until release', async () => {
    const firstRelease = jest.fn();
    const secondRelease = jest.fn();
    const makeClient = (releaseFn: jest.Mock) => ({
      query: jest.fn(),
      release: releaseFn,
    });
    const firstClient = makeClient(firstRelease);
    const secondClient = makeClient(secondRelease);
    const metrics = makeMetricsMock();
    const poolConnect = jest
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    jest.doMock('pg', () => ({
      Pool: jest.fn(() => ({
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        query: jest.fn(),
        connect: poolConnect,
        on: jest.fn(),
        end: jest.fn(),
      })),
    }));
    jest.doMock('../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
    jest.doMock('../src/utils/requestDbContext', () => ({ incrementDbQuery: jest.fn() }));
    jest.doMock('../src/utils/metrics', () => metrics);

    const dbPool = require('../src/db/pool') as {
      getClient: () => Promise<any>;
      queryGateStats: () => { active: number; waiting: number };
    };

    const checkedOut = await dbPool.getClient();
    expect(dbPool.queryGateStats()).toMatchObject({ active: 1, waiting: 0 });

    await expect(dbPool.getClient()).rejects.toMatchObject({
      code: 'PG_QUERY_GATE_SATURATED',
      statusCode: 503,
    });

    checkedOut.release();
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(dbPool.queryGateStats()).toMatchObject({ active: 0, waiting: 0 });

    const nextClient = await dbPool.getClient();
    expect(nextClient).toBe(secondClient);
    nextClient.release();
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });
});
