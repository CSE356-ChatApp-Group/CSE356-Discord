function createSearchRetryPolicy({
  logger,
  searchUseReadReplica,
  hasReadPool,
}: {
  logger: any;
  searchUseReadReplica: boolean;
  hasReadPool: boolean;
}) {
  function shouldRetrySearchOnPrimary(
    forcePrimary: boolean,
    result: { hits?: any[] } | null,
    err?: any,
  ) {
    if (forcePrimary || !searchUseReadReplica || !hasReadPool) return false;
    if (err?.statusCode === 403) return true;
    return Array.isArray(result?.hits) && result!.hits.length === 0;
  }

  function logPrimaryRetry(query: string, opts: Record<string, any>, reason: string) {
    logger.info(
      {
        query,
        communityId: opts.communityId,
        conversationId: opts.conversationId,
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
