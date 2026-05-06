function createSearchRetryPolicy({
  logger,
  searchUseReadReplica,
  hasReadPool,
  retryEmptyResultOnPrimary,
  searchReplicaRetryTotal,
}: {
  logger: any;
  searchUseReadReplica: boolean;
  hasReadPool: boolean;
  retryEmptyResultOnPrimary: boolean;
  searchReplicaRetryTotal: any;
}) {
  function shouldRetrySearchOnPrimary(
    forcePrimary: boolean,
    result: { hits?: any[] } | null,
    err?: any,
  ) {
    if (forcePrimary || !searchUseReadReplica || !hasReadPool) return false;
    if (err?.statusCode === 403) return true;
    // Replica connection returned in an aborted transaction state — retry on primary.
    if (err?.code === '25P02') return true;
    // pg-pool query_timeout fired on replica (no PG error code) — retry on primary.
    if (!err?.code && err?.message === 'Query read timeout') return true;
    return retryEmptyResultOnPrimary && Array.isArray(result?.hits) && result!.hits.length === 0;
  }

  function logPrimaryRetry(
    query: string,
    opts: Record<string, any>,
    reason: string,
    metricReason: string,
  ) {
    const scope = opts.communityId ? 'community' : (opts.conversationId ? 'conversation' : 'none');
    searchReplicaRetryTotal.inc({ scope, reason: metricReason });
    logger.info(
      {
        query,
        communityId: opts.communityId,
        conversationId: opts.conversationId,
        retry_reason: metricReason,
      },
      reason,
    );
  }

  function createMeiliFallbackError(code: string) {
    const err: any = new Error(code);
    err.meiliUnavailable = true;
    return err;
  }

  return {
    shouldRetrySearchOnPrimary,
    logPrimaryRetry,
    createMeiliFallbackError,
  };
}

module.exports = {
  createSearchRetryPolicy,
};
