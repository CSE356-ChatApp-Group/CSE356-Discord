/**
 * Env-backed tunables for search query execution (timeouts, replica, literal caps).
 */

const overload = require('../utils/overload');

const SEARCH_USE_READ_REPLICA =
  String(process.env.SEARCH_USE_READ_REPLICA || '').trim().toLowerCase() === 'true';

/**
 * Max recent messages scanned per scope before applying literal substring
 * (scoped total candidate set). Evaluated per query (not at module load).
 * Default 1500, clamped 1000..2000.
 */
function literalRecentCandidateCap(): number {
  const raw = parseInt(
    process.env.STOPWORD_LITERAL_RECENT_CANDIDATES_LIMIT ||
      process.env.STOPWORD_LITERAL_RECENT_PER_CHANNEL_LIMIT ||
      '1500',
    10,
  );
  const v = Number.isFinite(raw) && raw > 0 ? raw : 1500;
  return Math.min(Math.max(v, 1000), 2000);
}

/**
 * Deeper bounded scan for scoped literal rescue when FTS misses or is too weak.
 * Default 3000, clamped 2000..4000.
 */
function literalRecentCandidateCapDeep(): number {
  const raw = parseInt(
    process.env.STOPWORD_LITERAL_RECENT_CANDIDATES_LIMIT_DEEP ||
      process.env.SEARCH_LITERAL_RECENT_CANDIDATES_LIMIT_DEEP ||
      '3000',
    10,
  );
  const v = Number.isFinite(raw) && raw > 0 ? raw : 3000;
  return Math.min(Math.max(v, 2000), 4000);
}

function getSearchStatementTimeoutMs() {
  const rawMs = process.env.SEARCH_STATEMENT_TIMEOUT_MS;
  const configuredMs = Math.min(2000, Math.max(1500, parseInt(rawMs || '2000', 10) || 2000));
  const stage = overload.getStage();
  if (stage >= 2) return Math.min(configuredMs, 2000);
  if (stage >= 1) return Math.min(configuredMs, 2000);
  return configuredMs;
}

module.exports = {
  SEARCH_USE_READ_REPLICA,
  literalRecentCandidateCap,
  literalRecentCandidateCapDeep,
  getSearchStatementTimeoutMs,
};
