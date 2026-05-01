/**
 * Structured logging for search DB timing and search_trace payloads.
 */

const logger = require('../utils/logger');

function logSearchDbTiming(
  kind: string,
  acquireMs: number,
  queryMs: number,
  totalMs: number,
  extra: Record<string, unknown> = {},
) {
  const payload = {
    search_db_timing: true,
    kind,
    acquire_ms: acquireMs,
    query_ms: queryMs,
    total_ms: totalMs,
    ...extra,
  };
  if (totalMs > 300 || acquireMs > 50) {
    logger.warn(payload, 'search_db_timing');
  } else {
    logger.debug(payload, 'search_db_timing');
  }
}

function resolvedSearchScope(opts: Record<string, any>): string {
  if (opts.communityId) return 'community';
  if (opts.conversationId) return 'conversation';
  return 'none';
}

function logSearchTrace(payload: Record<string, unknown>) {
  logger.info({ search_trace: true, ...payload }, 'search_trace');
}

function buildBaseSearchTracePayload({
  requestId,
  query,
  scopeLabel,
  tsqueryText,
  tsqueryNodes,
  ftsHitCount,
  strictTermCount,
  strictFtsHitCount,
  queryMs,
  totalMs,
}: {
  requestId: string | undefined;
  query: string;
  scopeLabel: string;
  tsqueryText: string;
  tsqueryNodes: number;
  ftsHitCount: number;
  strictTermCount: number;
  strictFtsHitCount: number;
  queryMs: number;
  totalMs: number;
}): Record<string, unknown> {
  return {
    requestId,
    query,
    resolved_scope: scopeLabel,
    tsquery_text: tsqueryText,
    tsquery_node_count: tsqueryNodes,
    fts_hit_count: ftsHitCount,
    strict_term_count: strictTermCount,
    strict_fts_hit_count: strictFtsHitCount,
    total_ms: totalMs,
    query_ms: queryMs,
  };
}

function buildCommunityTraceFields(
  scopeLabel: string,
  communityFtsCandidateCount: unknown,
  resultCount: number,
): Record<string, unknown> {
  if (scopeLabel !== 'community') return {};
  return {
    fts_candidate_count: communityFtsCandidateCount,
    result_count: resultCount,
  };
}

module.exports = {
  logSearchDbTiming,
  resolvedSearchScope,
  logSearchTrace,
  buildBaseSearchTracePayload,
  buildCommunityTraceFields,
};
