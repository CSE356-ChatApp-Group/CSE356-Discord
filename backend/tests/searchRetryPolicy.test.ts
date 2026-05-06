describe('createSearchRetryPolicy', () => {
  it('can suppress primary retry on empty replica results when configured off', () => {
    const { createSearchRetryPolicy } = require('../src/search/retryPolicy');
    const policy = createSearchRetryPolicy({
      logger: { info: jest.fn() },
      searchUseReadReplica: true,
      hasReadPool: true,
      retryEmptyResultOnPrimary: false,
      searchReplicaRetryTotal: { inc: jest.fn() },
    });

    expect(
      policy.shouldRetrySearchOnPrimary(false, { hits: [] }),
    ).toBe(false);
  });

  it('still retries on access-check and replica transaction errors', () => {
    const { createSearchRetryPolicy } = require('../src/search/retryPolicy');
    const policy = createSearchRetryPolicy({
      logger: { info: jest.fn() },
      searchUseReadReplica: true,
      hasReadPool: true,
      retryEmptyResultOnPrimary: false,
      searchReplicaRetryTotal: { inc: jest.fn() },
    });

    expect(
      policy.shouldRetrySearchOnPrimary(false, null, { statusCode: 403 }),
    ).toBe(true);
    expect(
      policy.shouldRetrySearchOnPrimary(false, null, { code: '25P02' }),
    ).toBe(true);
    expect(
      policy.shouldRetrySearchOnPrimary(false, null, { message: 'Query read timeout' }),
    ).toBe(true);
  });

  it('records fallback reason labels when logging retries', () => {
    const info = jest.fn();
    const inc = jest.fn();
    const { createSearchRetryPolicy } = require('../src/search/retryPolicy');
    const policy = createSearchRetryPolicy({
      logger: { info },
      searchUseReadReplica: true,
      hasReadPool: true,
      retryEmptyResultOnPrimary: true,
      searchReplicaRetryTotal: { inc },
    });

    policy.logPrimaryRetry(
      'needle',
      { communityId: 'community-1' },
      'search: replica returned empty result set, retrying on primary',
      'empty_result',
    );

    expect(inc).toHaveBeenCalledWith({ scope: 'community', reason: 'empty_result' });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'needle',
        communityId: 'community-1',
        retry_reason: 'empty_result',
      }),
      'search: replica returned empty result set, retrying on primary',
    );
  });
});
