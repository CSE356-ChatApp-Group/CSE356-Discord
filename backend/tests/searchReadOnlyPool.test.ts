describe('search read-only pool isolation', () => {
  const originalSearchUseReadReplica = process.env.SEARCH_USE_READ_REPLICA;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    if (originalSearchUseReadReplica == null) {
      delete process.env.SEARCH_USE_READ_REPLICA;
    } else {
      process.env.SEARCH_USE_READ_REPLICA = originalSearchUseReadReplica;
    }
  });

  it('uses the dedicated search read pool without mutating the shared read pool session', async () => {
    process.env.SEARCH_USE_READ_REPLICA = 'true';
    jest.resetModules();

    const searchReadQuery = jest.fn().mockResolvedValue({ rows: [{ id: 'row-1' }] });
    const sharedReadQuery = jest.fn();
    const primaryQuery = jest.fn();
    const getClientTimed = jest.fn();

    jest.doMock('../src/db/pool', () => ({
      searchReadPool: { query: searchReadQuery },
      readPool: { query: sharedReadQuery },
      query: primaryQuery,
      getClientTimed,
    }));

    const { runSearchReadOnlyQuery } = require('../src/search/searchExecution');
    const rows = await runSearchReadOnlyQuery('SELECT $1::text AS id', ['row-1'], {
      kind: 'meili_recheck_query',
    });

    expect(rows).toEqual([{ id: 'row-1' }]);
    expect(searchReadQuery).toHaveBeenCalledWith('SELECT $1::text AS id', ['row-1']);
    expect(sharedReadQuery).not.toHaveBeenCalled();
    expect(primaryQuery).not.toHaveBeenCalled();
    expect(getClientTimed).not.toHaveBeenCalled();
  });
});
