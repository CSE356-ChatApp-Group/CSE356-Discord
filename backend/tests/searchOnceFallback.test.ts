/**
 * Unit tests for searchOnce: FTS-first, scoped literal rescue when FTS returns
 * zero rows, structured search_trace logging (mocked DB client).
 */

import { uniqueSuffix } from './helpers';

describe('search() – FTS zero → scoped literal', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('invokes bounded literal fallback when FTS returns no hit rows (scoped)', async () => {
    jest.resetModules();
    const logger = require('../src/utils/logger');
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    const pool = require('../src/db/pool');
    const mockQuery = jest.fn();
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ tsquery_text: "'make' & 'foo'", tsquery_nodes: 2 }],
      })
      .mockResolvedValueOnce({
        rows: [{ __scopeAccess: true }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            __scopeAccess: true,
            id: '00000000-0000-4000-8000-000000000001',
            content: 'That makes more tail',
            authorId: '00000000-0000-4000-8000-000000000002',
            authorDisplayName: 'A',
            channelId: '00000000-0000-4000-8000-000000000003',
            conversationId: null,
            communityId: '00000000-0000-4000-8000-000000000004',
            channelName: 'general',
            createdAt: '2026-04-23T12:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({});

    jest.spyOn(pool, 'getClientTimed').mockResolvedValue({
      client: { query: mockQuery, release: jest.fn() },
      acquireMs: 0,
    });

    const { search } = require('../src/search/client');

    const out = await search('That makes more', {
      communityId: '00000000-0000-4000-8000-000000000004',
      userId: '00000000-0000-4000-8000-000000000002',
      limit: 10,
      offset: 0,
      requestId: `req-fallback-${uniqueSuffix()}`,
    });

    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].content).toContain('That makes more');
    expect(mockQuery).toHaveBeenCalledTimes(8);

    const traceCall = infoSpy.mock.calls.find((c) => c[1] === 'search_trace');
    expect(traceCall).toBeDefined();
    expect(traceCall![0]).toMatchObject({
      search_trace: true,
      query: 'That makes more',
      resolved_scope: 'community',
      fallback_used: true,
      fts_hit_count: 0,
      fallback_hit_count: 1,
      tsquery_node_count: 2,
    });
    const tracePayload = traceCall![0] as Record<string, unknown>;
    expect(String(tracePayload.requestId)).toMatch(/^req-fallback-/);
    expect(typeof tracePayload.total_ms).toBe('number');
    expect(typeof tracePayload.query_ms).toBe('number');
  });

  it('does not call literal fallback when FTS returns hits', async () => {
    jest.resetModules();
    const logger = require('../src/utils/logger');
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    const pool = require('../src/db/pool');
    const mockQuery = jest.fn();
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ tsquery_text: "'unicorn'", tsquery_nodes: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            __scopeAccess: true,
            id: '00000000-0000-4000-8000-000000000011',
            content: 'unicorn marker',
            authorId: '00000000-0000-4000-8000-000000000012',
            authorDisplayName: 'B',
            channelId: '00000000-0000-4000-8000-000000000013',
            conversationId: null,
            communityId: '00000000-0000-4000-8000-000000000014',
            channelName: 'general',
            createdAt: '2026-04-23T12:00:00.000Z',
            highlight: 'unicorn marker',
          },
        ],
      })
      .mockResolvedValueOnce({});

    jest.spyOn(pool, 'getClientTimed').mockResolvedValue({
      client: { query: mockQuery, release: jest.fn() },
      acquireMs: 0,
    });

    const { search } = require('../src/search/client');

    await search('unicorn', {
      communityId: '00000000-0000-4000-8000-000000000014',
      userId: '00000000-0000-4000-8000-000000000012',
      limit: 5,
      offset: 0,
    });

    expect(mockQuery).toHaveBeenCalledTimes(7);
    const traceCall = infoSpy.mock.calls.find((c) => c[1] === 'search_trace');
    expect(traceCall![0]).toMatchObject({
      fallback_used: false,
      fts_hit_count: 1,
      fallback_hit_count: 0,
    });
  });

  it('stopword-only query runs FTS then literal (scoped)', async () => {
    jest.resetModules();
    const logger = require('../src/utils/logger');
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    const pool = require('../src/db/pool');
    const mockQuery = jest.fn();
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ tsquery_text: '', tsquery_nodes: 0 }],
      })
      .mockResolvedValueOnce({
        rows: [{ __scopeAccess: true }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            __scopeAccess: true,
            id: '00000000-0000-4000-8000-000000000021',
            content: 'more just about life',
            authorId: '00000000-0000-4000-8000-000000000022',
            authorDisplayName: 'C',
            channelId: '00000000-0000-4000-8000-000000000023',
            conversationId: null,
            communityId: '00000000-0000-4000-8000-000000000024',
            channelName: 'general',
            createdAt: '2026-04-23T12:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({});

    jest.spyOn(pool, 'getClientTimed').mockResolvedValue({
      client: { query: mockQuery, release: jest.fn() },
      acquireMs: 0,
    });

    const { search } = require('../src/search/client');

    const out = await search('more just about', {
      communityId: '00000000-0000-4000-8000-000000000024',
      userId: '00000000-0000-4000-8000-000000000022',
      limit: 20,
      offset: 0,
    });

    expect(out.hits.length).toBeGreaterThan(0);
    expect(mockQuery).toHaveBeenCalledTimes(8);
    const traceCall = infoSpy.mock.calls.find((c) => c[1] === 'search_trace');
    expect(traceCall![0]).toMatchObject({
      tsquery_node_count: 0,
      fts_hit_count: 0,
      fallback_used: true,
    });
  });
});
