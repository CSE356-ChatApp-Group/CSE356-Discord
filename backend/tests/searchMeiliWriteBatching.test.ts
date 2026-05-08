/**
 * Coverage for the Meilisearch write batching / coalescing path.
 *
 * These tests pin the behavior fixed in 2026-05-07 after the prod env was
 * found to submit 1000-doc Meili tasks even though MEILI_WRITE_BATCH_SIZE
 * was 500: the stream consumer used MEILI_WRITE_STREAM_READ_COUNT (1000)
 * as the per-task size and ignored MEILI_WRITE_BATCH_SIZE entirely. The
 * fix routes the stream-consumer path through MEILI_WRITE_STREAM_TASK_CHUNK
 * (defaults to MEILI_WRITE_BATCH_SIZE), so a single env knob bounds
 * documents-per-Meili-task on every code path.
 *
 * The tests also lock in:
 *   - producer stamps `enqueuedAtMs` on every stream payload
 *   - the consumer coalesces multiple ops for the same id (last write wins)
 *   - retry-on-failure semantics (no XACK on chunk failure)
 *   - new lag/batch metrics are emitted with the right labels
 */

describe('meiliClient write batching / coalescing', () => {
  const OLD_ENV = process.env;

  let xaddMock: jest.Mock;
  let xackMock: jest.Mock;
  let fetchMock: jest.Mock;

  function loadModule(envOverrides: Record<string, string> = {}) {
    jest.resetModules();
    process.env = {
      ...OLD_ENV,
      MEILI_ENABLED: 'true',
      MEILI_HOST: 'http://meili.test',
      MEILI_MASTER_KEY: 'test-key',
      MEILI_INDEX_MESSAGES: 'messages',
      MEILI_WRITE_STREAM_KEY: 'meili:messages:write:test',
      MEILI_WRITE_STREAM_GROUP: 'meili-indexers-test',
      ...envOverrides,
    };
    require('prom-client').register.clear();

    xaddMock = jest.fn().mockResolvedValue('0-0');
    xackMock = jest.fn().mockResolvedValue(1);
    jest.doMock('../src/db/redis', () => ({
      redisSearch: {
        xadd: xaddMock,
        xack: xackMock,
        duplicate: jest.fn(),
      },
    }));

    return require('../src/search/meiliClient');
  }

  function makeStreamEntry(
    id: string,
    op: 'upsert' | 'delete',
    payload: Record<string, unknown>,
  ): [string, string[]] {
    return [id, ['op', op, 'payload', JSON.stringify(payload)]];
  }

  function makeUpsertDoc(id: string, content = 'hello world') {
    return {
      id,
      content,
      authorId: '00000000-0000-4000-8000-aaaaaaaaaaaa',
      channelId: '00000000-0000-4000-8000-bbbbbbbbbbbb',
      communityId: '00000000-0000-4000-8000-cccccccccccc',
      conversationId: null,
      createdAt: 1700000000000,
      updatedAt: null,
    };
  }

  beforeEach(() => {
    fetchMock = jest.fn().mockImplementation(async (_url: string) => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ taskUid: 42 }),
      text: async () => '',
    }));
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
    delete (global as any).fetch;
  });

  it('producer stamps enqueuedAtMs on every stream payload', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'true',
      // Disable consumer so this test does not race the in-process loop.
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
    });

    const before = Date.now();
    await meili.indexMessage(makeUpsertDoc('00000000-0000-4000-8000-000000000001'));
    const after = Date.now();

    expect(xaddMock).toHaveBeenCalledTimes(1);
    const args = xaddMock.mock.calls[0];
    // ioredis xadd shape: key, MAXLEN, ~, n, *, op, <op>, payload, <json>
    const payloadIdx = args.indexOf('payload');
    expect(payloadIdx).toBeGreaterThan(-1);
    const payload = JSON.parse(String(args[payloadIdx + 1]));
    expect(payload.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(typeof payload.enqueuedAtMs).toBe('number');
    expect(payload.enqueuedAtMs).toBeGreaterThanOrEqual(before);
    expect(payload.enqueuedAtMs).toBeLessThanOrEqual(after);
  });

  it('chunks coalesced stream batches by MEILI_WRITE_STREAM_TASK_CHUNK', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'true',
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
      MEILI_WRITE_BATCH_SIZE: '50',
      // Explicit chunk lower than the simulated coalesced-batch size to
      // make the splitting deterministic.
      MEILI_WRITE_STREAM_TASK_CHUNK: '50',
    });

    const enqueuedAt = Date.now() - 1234;
    const entries: Array<[string, string[]]> = [];
    for (let i = 0; i < 175; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      entries.push(
        makeStreamEntry(`${enqueuedAt}-${i}`, 'upsert', { ...makeUpsertDoc(id), enqueuedAtMs: enqueuedAt }),
      );
    }

    await meili.__test.processMeiliWriteStreamMessages({ xack: xackMock }, entries);

    // 175 docs / 50 per chunk = 4 POSTs (50 + 50 + 50 + 25)
    const docPosts = fetchMock.mock.calls.filter(([url]: [string]) => (
      url.endsWith('/indexes/messages/documents')
    ));
    expect(docPosts).toHaveLength(4);

    const sentBatchSizes = docPosts.map(([, init]: [string, any]) => (
      JSON.parse(String(init.body)).length
    ));
    expect(sentBatchSizes).toEqual([50, 50, 50, 25]);

    // All 175 entries are acknowledged exactly once.
    expect(xackMock).toHaveBeenCalledTimes(1);
    const ackArgs = xackMock.mock.calls[0];
    // First three positional args are stream key + group + first id; remaining are IDs.
    expect(ackArgs.slice(2)).toHaveLength(175);
  });

  it('coalesces multiple ops for the same id (last write wins)', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'true',
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
      MEILI_WRITE_BATCH_SIZE: '50',
      MEILI_WRITE_STREAM_TASK_CHUNK: '50',
    });

    const id = '00000000-0000-4000-8000-cccccccccccc';
    const enqueuedAt = Date.now() - 500;
    const entries: Array<[string, string[]]> = [
      makeStreamEntry(`${enqueuedAt}-0`, 'upsert', {
        ...makeUpsertDoc(id, 'first revision'),
        enqueuedAtMs: enqueuedAt,
      }),
      makeStreamEntry(`${enqueuedAt + 10}-0`, 'upsert', {
        ...makeUpsertDoc(id, 'final revision'),
        enqueuedAtMs: enqueuedAt + 10,
      }),
    ];

    await meili.__test.processMeiliWriteStreamMessages({ xack: xackMock }, entries);

    const docPosts = fetchMock.mock.calls.filter(([url]: [string]) => (
      url.endsWith('/indexes/messages/documents')
    ));
    expect(docPosts).toHaveLength(1);
    const body = JSON.parse(String(docPosts[0][1].body));
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(id);
    expect(body[0].content).toBe('final revision');

    // Both stream entries are still acked even though only one Meili doc
    // was POSTed (last-write-wins).
    const ackArgs = xackMock.mock.calls[0];
    expect(ackArgs.slice(2)).toHaveLength(2);
  });

  it('does not XACK any stream entries when a chunk fails (XAUTOCLAIM redelivery)', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'true',
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
      MEILI_WRITE_BATCH_SIZE: '50',
      MEILI_WRITE_STREAM_TASK_CHUNK: '50',
    });

    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/indexes/messages/documents')) {
        calls += 1;
        if (calls === 2) {
          // Second chunk fails — entire batch should retry via XAUTOCLAIM.
          return {
            ok: false,
            headers: { get: () => 'application/json' },
            text: async () => 'boom',
          };
        }
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ taskUid: calls }),
        text: async () => '',
      };
    });

    const enqueuedAt = Date.now();
    const entries: Array<[string, string[]]> = [];
    for (let i = 0; i < 60; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      entries.push(
        makeStreamEntry(`${enqueuedAt}-${i}`, 'upsert', { ...makeUpsertDoc(id), enqueuedAtMs: enqueuedAt }),
      );
    }

    await expect(
      meili.__test.processMeiliWriteStreamMessages({ xack: xackMock }, entries),
    ).rejects.toBeDefined();

    expect(xackMock).not.toHaveBeenCalled();
  });

  it('emits batch-size, flush-duration, and enqueue-to-flush-lag metrics with op label', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'true',
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
      MEILI_WRITE_BATCH_SIZE: '10',
      MEILI_WRITE_STREAM_TASK_CHUNK: '10',
    });

    const enqueuedAt = Date.now() - 250;
    const entries: Array<[string, string[]]> = [];
    for (let i = 0; i < 7; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      entries.push(
        makeStreamEntry(`${enqueuedAt}-${i}`, 'upsert', { ...makeUpsertDoc(id), enqueuedAtMs: enqueuedAt }),
      );
    }

    await meili.__test.processMeiliWriteStreamMessages({ xack: xackMock }, entries);

    const metrics = await require('prom-client').register.metrics();
    expect(metrics).toMatch(/meili_write_batch_size_count\{[^}]*op="upsert"[^}]*\} 1/);
    expect(metrics).toMatch(/meili_write_flush_duration_ms_count\{[^}]*op="index_stream"[^}]*\} 1/);
    expect(metrics).toMatch(/meili_write_enqueue_to_flush_lag_ms_count\{[^}]*op="upsert"[^}]*\} 7/);
  });

  it('local in-process flush also caps each Meili POST at MEILI_WRITE_BATCH_SIZE', async () => {
    const meili = loadModule({
      // Stream disabled → indexMessage uses the local flush path.
      MEILI_WRITE_STREAM_ENABLED: 'false',
      MEILI_WRITE_BATCH_SIZE: '5',
      MEILI_WRITE_FLUSH_MS: '5',
    });

    for (let i = 0; i < 12; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await meili.indexMessage(makeUpsertDoc(id, `c${i}`));
    }

    // Drain pending writes deterministically.
    await meili.__test.flushPendingWrites();

    const docPosts = fetchMock.mock.calls.filter(([url]: [string]) => (
      url.endsWith('/indexes/messages/documents')
    ));
    const sizes = docPosts.map(([, init]: [string, any]) => (
      JSON.parse(String(init.body)).length
    ));
    // 12 docs / 5 per batch = [5, 5, 2]
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(12);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
  });

  it('sampleQueueDepth observes XLEN into the meili_write_queue_depth gauge', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'true',
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
    });

    const xlen = jest.fn().mockResolvedValue(123);
    await meili.__test.sampleQueueDepth({ xlen });
    expect(xlen).toHaveBeenCalledWith('meili:messages:write:test');

    const metrics = await require('prom-client').register.metrics();
    // Gauge has no labels, so it appears as `meili_write_queue_depth 123`.
    expect(metrics).toMatch(/meili_write_queue_depth(?:\{[^}]*\})? 123/);
  });

  it('pollMeiliTaskMetrics records wait + duration on terminal task status', async () => {
    const meili = loadModule({
      MEILI_WRITE_STREAM_ENABLED: 'false',
      MEILI_TASK_METRICS_POLL_MIN_MS: '50',
      MEILI_TASK_METRICS_POLL_MAX_MS: '50',
    });

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/tasks/')) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            uid: 7,
            status: 'succeeded',
            type: 'documentAdditionOrUpdate',
            enqueuedAt: '2026-05-07T19:00:00.000Z',
            startedAt: '2026-05-07T19:00:01.500Z',
            finishedAt: '2026-05-07T19:00:03.000Z',
          }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({}),
        text: async () => '',
      };
    });

    await meili.__test.pollMeiliTaskMetrics(7, 'index_stream');

    const metrics = await require('prom-client').register.metrics();
    // wait = 1500 ms (between 1000-bucket and 2500-bucket)
    expect(metrics).toMatch(
      /meili_task_wait_ms_count\{[^}]*type="documentAdditionOrUpdate"[^}]*status="succeeded"[^}]*\} 1/,
    );
    // duration = 1500 ms
    expect(metrics).toMatch(
      /meili_task_duration_ms_count\{[^}]*type="documentAdditionOrUpdate"[^}]*status="succeeded"[^}]*\} 1/,
    );
  });
});
