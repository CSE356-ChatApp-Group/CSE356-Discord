/**
 * Env-backed tunables for search query execution (timeouts, replica, literal caps).
 */

const overload = require('../utils/overload');

const SEARCH_USE_READ_REPLICA =
  String(process.env.SEARCH_USE_READ_REPLICA || '').trim().toLowerCase() === 'true';

const SEARCH_REPLICA_EMPTY_RESULT_RETRY_ENABLED =
  String(process.env.SEARCH_REPLICA_EMPTY_RESULT_RETRY_ENABLED ?? 'true')
    .trim()
    .toLowerCase() !== 'false';

const SEARCH_RECHECK_USE_READ_REPLICA =
  String(process.env.SEARCH_RECHECK_USE_READ_REPLICA || '').trim().toLowerCase() === 'true';

const SEARCH_BACKEND = String(process.env.SEARCH_BACKEND || 'meili').trim().toLowerCase();
const OPENSEARCH_DUAL_WRITE_ENABLED =
  String(process.env.OPENSEARCH_DUAL_WRITE_ENABLED || 'false').trim().toLowerCase() === 'true';
const OPENSEARCH_READ_ENABLED =
  String(process.env.OPENSEARCH_READ_ENABLED || 'false').trim().toLowerCase() === 'true';

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

/**
 * Meili strict-token mismatch fallback is a correctness rescue after Meili has
 * already returned candidates that failed the exact all-term check. Keep it
 * shallower than the full Postgres fallback so a rare rescue does not spend the
 * whole search timeout budget under load.
 */
function literalStrictMismatchCandidateCap(): number {
  const raw = parseInt(
    process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT || '1000',
    10,
  );
  const v = Number.isFinite(raw) && raw > 0 ? raw : 1000;
  return Math.min(Math.max(v, 500), 1500);
}

/**
 * Deeper bounded scan for FTS candidate generation when initial FTS returns
 * no strict hits. This reduces false empties from hot-path candidate windows
 * while still keeping the query bounded.
 * Default 2500, clamped 1200..5000.
 */
function ftsRecentCandidateCapDeep(): number {
  const raw = parseInt(
    process.env.SEARCH_FTS_RECENT_CANDIDATES_LIMIT_DEEP || '2500',
    10,
  );
  const v = Number.isFinite(raw) && raw > 0 ? raw : 2500;
  return Math.min(Math.max(v, 1200), 5000);
}

function getSearchStatementTimeoutMs() {
  const rawMs = process.env.SEARCH_STATEMENT_TIMEOUT_MS;
  const configuredMs = Math.min(2000, Math.max(1500, parseInt(rawMs || '2000', 10) || 2000));
  const stage = overload.getStage();
  if (stage >= 2) return Math.min(configuredMs, 2000);
  if (stage >= 1) return Math.min(configuredMs, 2000);
  return configuredMs;
}

function meiliFreshnessWindowMs(): number {
  const raw = parseInt(process.env.MEILI_FRESHNESS_WINDOW_MS || '600000', 10);
  // 0 means disabled; positive values are clamped to [0, 3600000].
  if (raw === 0) return 0;
  const value = Number.isFinite(raw) && raw > 0 ? raw : 600000;
  return Math.min(Math.max(value, 0), 3600000);
}

function meiliFreshnessCandidateCap(): number {
  const raw = parseInt(process.env.MEILI_FRESHNESS_CANDIDATE_LIMIT || '15', 10);
  const value = Number.isFinite(raw) && raw > 0 ? raw : 15;
  const baseCap = Math.min(Math.max(value, 10), 200);

  // Optional adaptive cap for overload stages (disabled when explicitly set false).
  const adaptiveEnabled =
    String(process.env.MEILI_FRESHNESS_ADAPTIVE_CAP_ENABLED || 'true')
      .trim()
      .toLowerCase() !== 'false';
  if (!adaptiveEnabled) return baseCap;

  const stage = overload.getStage();
  const stage2Raw = parseInt(process.env.MEILI_FRESHNESS_CANDIDATE_LIMIT_STAGE2 || '12', 10);
  const stage3Raw = parseInt(process.env.MEILI_FRESHNESS_CANDIDATE_LIMIT_STAGE3 || '10', 10);
  const stage2Cap = Math.min(Math.max(Number.isFinite(stage2Raw) && stage2Raw > 0 ? stage2Raw : 12, 5), baseCap);
  const stage3Cap = Math.min(Math.max(Number.isFinite(stage3Raw) && stage3Raw > 0 ? stage3Raw : 10, 5), baseCap);

  if (stage >= 3) return Math.min(baseCap, stage3Cap);
  if (stage >= 2) return Math.min(baseCap, stage2Cap);
  return baseCap;
}

function meiliEmptyCandidatesFallbackEnabled(): boolean {
  const raw = process.env.MEILI_EMPTY_CANDIDATES_FALLBACK_ENABLED;
  if (raw === undefined || raw === '') return false;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** When Meilisearch returns zero candidates: bounded Postgres literal scan over very recent messages only. */
function emptyMeiliRecentRescueEnabled(): boolean {
  return (
    String(process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_ENABLED || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

/** Wall-clock window (ms) for recent-message rescue; clamped 10s–5m, default 120s. */
function emptyMeiliRecentRescueWindowMs(): number {
  const raw = parseInt(process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_WINDOW_MS || '120000', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 120000;
  return Math.min(Math.max(v, 10_000), 300_000);
}

/** Max rows scanned in the recent window (ORDER BY created_at DESC LIMIT n). Default 250, clamp 50–500. */
function emptyMeiliRecentRescueLimit(): number {
  const raw = parseInt(process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_LIMIT || '250', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 250;
  return Math.min(Math.max(v, 50), 500);
}

/** Statement timeout for the rescue query only. Default 120ms, clamp 50–500ms. */
function emptyMeiliRecentRescueTimeoutMs(): number {
  const raw = parseInt(process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_TIMEOUT_MS || '120', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 120;
  return Math.min(Math.max(v, 50), 500);
}

function openSearchMaxCandidates(): number {
  const raw = parseInt(process.env.OPENSEARCH_MAX_CANDIDATES || '250', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 250;
  return Math.min(Math.max(v, 50), 2000);
}

module.exports = {
  SEARCH_BACKEND,
  SEARCH_USE_READ_REPLICA,
  SEARCH_RECHECK_USE_READ_REPLICA,
  SEARCH_REPLICA_EMPTY_RESULT_RETRY_ENABLED,
  OPENSEARCH_DUAL_WRITE_ENABLED,
  OPENSEARCH_READ_ENABLED,
  literalRecentCandidateCap,
  literalRecentCandidateCapDeep,
  literalStrictMismatchCandidateCap,
  ftsRecentCandidateCapDeep,
  getSearchStatementTimeoutMs,
  meiliFreshnessWindowMs,
  meiliFreshnessCandidateCap,
  meiliEmptyCandidatesFallbackEnabled,
  emptyMeiliRecentRescueEnabled,
  emptyMeiliRecentRescueWindowMs,
  emptyMeiliRecentRescueLimit,
  emptyMeiliRecentRescueTimeoutMs,
  openSearchMaxCandidates,
};
