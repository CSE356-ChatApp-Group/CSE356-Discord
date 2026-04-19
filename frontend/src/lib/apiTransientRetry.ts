/**
 * Shared logic for retrying safe HTTP operations after transient upstream failures.
 * Used by frontend/src/lib/api.ts — keep pure (easy to unit test).
 */

/** Status codes we treat as retryable for idempotent or deduped writes / reads. */
export const TRANSIENT_RETRY_STATUS = new Set([503, 429]);

export function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const asInt = parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1000, 60_000);
  }

  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) {
    const delta = when - Date.now();
    if (delta > 0) return Math.min(delta, 60_000);
  }
  return undefined;
}

/**
 * Milliseconds to wait before the next attempt.
 * Honors `Retry-After` as a floor when the server sends it; otherwise exponential backoff.
 */
export function nextTransientWaitMs(attemptIndex: number, res: Response): number {
  const fromHeader = parseRetryAfterMs(res) ?? 0;
  const exponential = Math.min(10_000, 200 * 2 ** attemptIndex);
  return Math.min(15_000, Math.max(fromHeader, exponential));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether this method/path may use transient retries.
 * POST /messages is only eligible when `idempotencyKey` is non-empty — never
 * retry mutating POSTs without the server's dedupe header.
 */
export function allowsTransientRetry(
  method: string,
  path: string,
  idempotencyKeyForMessagePost?: string | null,
): boolean {
  if (method === 'GET') return true;
  if (method === 'POST' && path === '/messages') {
    return Boolean(idempotencyKeyForMessagePost && idempotencyKeyForMessagePost.trim());
  }
  return false;
}

export function isTransientRetryStatus(status: number): boolean {
  return TRANSIENT_RETRY_STATUS.has(status);
}
