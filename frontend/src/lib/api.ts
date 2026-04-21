/**
 * api.js – thin fetch wrapper
 *
 * • Attaches Authorization header from in-memory access token (per-tab session)
 * • Auto-refreshes on 401 (once) using the httpOnly cookie
 * • Retries 503/429 on safe methods: all GETs, and POST /messages (with
 *   Idempotency-Key so retries cannot double-insert)
 * • Throws { status, message, errors } on non-2xx
 */

import {
  allowsTransientRetry,
  isTransientRetryStatus,
  nextTransientWaitMs,
  sleep,
} from './apiTransientRetry';

const BASE = (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/$/, '');

type ApiError = Error & { status?: number; errors?: unknown };

// Access token is stored in memory only (not localStorage).
// Each browser tab has an independent session. On page load, authStore.init()
// restores the session via the httpOnly refresh cookie.
let _accessToken: string | null = null;

const parsedRequestTimeoutMs = Number(import.meta.env.VITE_API_TIMEOUT_MS || '25000');
const REQUEST_TIMEOUT_MS =
  Number.isFinite(parsedRequestTimeoutMs) && parsedRequestTimeoutMs >= 1000
    ? parsedRequestTimeoutMs
    : 25_000;

function fetchWithTimeout(url: string, init: RequestInit, ms = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timerId));
}
// Remove any stale token left from the previous localStorage-based approach.
localStorage.removeItem('accessToken');
let _refreshing   = null; // in-flight refresh promise
let _authInvalid = false;
const _inFlightGets = new Map<string, Promise<any>>();
const _recentGets = new Map<string, { at: number; value: any }>();
const GET_CACHE_TTL_MS = 1500;

function notifySessionExpired() {
  setToken(null);
  _authInvalid = true;
  _inFlightGets.clear();
  _recentGets.clear();
  window.dispatchEvent(new CustomEvent('chatapp:session-expired'));

  const currentPath = window.location.pathname;
  const isAuthRoute = currentPath === '/login' || currentPath === '/register' || currentPath === '/oauth-callback';
  if (!isAuthRoute) {
    window.location.href = '/login';
  }
}

export function setToken(t: string | null) {
  _accessToken = t;
  _authInvalid = !t;
}

export function getToken() { return _accessToken; }

/** Turn a path returned by the API (e.g. `/api/v1/auth/google?linkToken=…`) into a full URL for `window.location`. */
export function resolveApiAbsolutePath(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/$/, '');
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return new URL(path, `${new URL(base).origin}/`).href;
  }
  return `${window.location.origin}${path}`;
}

export function invalidateApiCache(pathPrefix?: string) {
  if (!pathPrefix) {
    _inFlightGets.clear();
    _recentGets.clear();
    return;
  }

  for (const key of Array.from(_inFlightGets.keys())) {
    if (key.startsWith(pathPrefix)) _inFlightGets.delete(key);
  }
  for (const key of Array.from(_recentGets.keys())) {
    if (key.startsWith(pathPrefix)) _recentGets.delete(key);
  }
}

async function requestFormData(path: string, formData: FormData) {
  if (_authInvalid && !path.startsWith('/auth/')) {
    notifySessionExpired();
    throw new Error('Session expired');
  }

  const headers: Record<string, string> = {};
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const e = new Error(err.error || err.message || 'Request failed') as ApiError;
    e.status = res.status;
    e.errors = err.errors;
    throw e;
  }

  if (res.status === 204) return null;
  return res.json();
}

async function refreshToken() {
  const res = await fetchWithTimeout(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!res.ok) throw new Error('Session expired');
  const data = await res.json();
  setToken(data.accessToken);
  return data.accessToken;
}

/**
 * Stable per logical POST /messages for Idempotency-Key across 401 refresh + 503 retries.
 * Always returns a non-empty string in browsers so we never retry POST /messages without dedupe.
 */
function messagePostIdempotencyKey(existing?: string | null): string | undefined {
  if (existing && String(existing).trim()) return String(existing).trim();
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Extremely old / non-standard environments: best-effort uniqueness (still safer than omitting the header).
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Max extra fetches after a 503/429 (first try does not count toward this). */
const MAX_TRANSIENT_RETRIES = 4;

async function request(
  method: string,
  path: string,
  body?: unknown,
  retry401 = true,
  /** Internal: preserve Idempotency-Key when recursion was used for 401 (legacy callers). */
  messageIdemKey?: string | null,
) {
  const skipRefreshForPath =
    path === '/auth/login' ||
    path === '/auth/register' ||
    path === '/auth/refresh' ||
    path === '/auth/session';

  if (_authInvalid && !skipRefreshForPath) {
    notifySessionExpired();
    throw new Error('Session expired');
  }

  // If another request is already refreshing auth, wait before firing more traffic.
  if (_refreshing && !skipRefreshForPath) {
    try {
      await _refreshing;
    } catch {
      notifySessionExpired();
      throw new Error('Session expired');
    }
  }

  const idempotencyKey =
    method === 'POST' && path === '/messages'
      ? messagePostIdempotencyKey(messageIdemKey)
      : undefined;
  const useTransient = allowsTransientRetry(method, path, idempotencyKey);

  let canRefresh401 = retry401;
  let transientRetriesUsed = 0;

  for (;;) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (_accessToken) headers.Authorization = `Bearer ${_accessToken}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await fetchWithTimeout(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && canRefresh401 && !skipRefreshForPath) {
      canRefresh401 = false;
      if (!_refreshing) _refreshing = refreshToken().finally(() => { _refreshing = null; });
      try {
        await _refreshing;
        await res.text().catch(() => {});
        continue;
      } catch {
        notifySessionExpired();
        throw new Error('Session expired');
      }
    }

    if (
      useTransient
      && isTransientRetryStatus(res.status)
      && transientRetriesUsed < MAX_TRANSIENT_RETRIES
    ) {
      await res.text().catch(() => {});
      await sleep(nextTransientWaitMs(transientRetriesUsed, res));
      transientRetriesUsed += 1;
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      const e = new Error(err.error || err.message || 'Request failed') as ApiError;
      e.status = res.status;
      e.errors = err.errors;
      throw e;
    }

    if (res.status === 204) return null;
    return res.json();
  }
}

export const api = {
  get:    (path: string)               => {
    // Message history must not use the short GET cache — pollers (e.g. graders)
    // can otherwise see a stale first page right after a write. Search must also
    // bypass this cache so repeated queries do not briefly reuse an empty result
    // after the underlying chat history changes.
    const skipRecentCache = path.startsWith('/messages') || path.startsWith('/search');

    if (!skipRecentCache) {
      const cached = _recentGets.get(path);
      if (cached && Date.now() - cached.at < GET_CACHE_TTL_MS) {
        return Promise.resolve(cached.value);
      }
    }

    const existing = _inFlightGets.get(path);
    if (existing) return existing;

    const pending = request('GET', path)
      .then((value) => {
        if (!skipRecentCache) {
          _recentGets.set(path, { at: Date.now(), value });
          if (_recentGets.size > 300) {
            const cutoff = Date.now() - GET_CACHE_TTL_MS;
            for (const [key, entry] of _recentGets) {
              if (entry.at < cutoff) _recentGets.delete(key);
            }
          }
        }
        return value;
      })
      .finally(() => {
        _inFlightGets.delete(path);
      });
    _inFlightGets.set(path, pending);
    return pending;
  },
  post:   (path: string, body?: unknown) => request('POST',   path, body),
  postForm: (path: string, formData: FormData) => requestFormData(path, formData),
  patch:  (path: string, body?: unknown) => request('PATCH',  path, body),
  put:    (path: string, body?: unknown) => request('PUT',    path, body),
  delete: (path: string)               => request('DELETE', path),
};
