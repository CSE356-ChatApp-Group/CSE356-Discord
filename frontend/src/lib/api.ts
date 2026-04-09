/**
 * api.js – thin fetch wrapper
 *
 * • Attaches Authorization header from in-memory access token (per-tab session)
 * • Auto-refreshes on 401 (once) using the httpOnly cookie
 * • Throws { status, message, errors } on non-2xx
 */

const BASE = (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/$/, '');

type ApiError = Error & { status?: number; errors?: unknown };

// Access token is stored in memory only (not localStorage).
// Each browser tab has an independent session. On page load, authStore.init()
// restores the session via the httpOnly refresh cookie.
let _accessToken: string | null = null;

// Maximum time to wait for any single API request before aborting. Prevents the
// app from getting stuck indefinitely when the server is slow or unreachable.
const REQUEST_TIMEOUT_MS = 12_000;

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

async function request(method: string, path: string, body?: unknown, retry = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

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

  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry && !skipRefreshForPath) {
    // Deduplicate concurrent refresh attempts
    if (!_refreshing) _refreshing = refreshToken().finally(() => { _refreshing = null; });
    try {
      await _refreshing;
      return request(method, path, body, false);
    } catch {
      notifySessionExpired();
      throw new Error('Session expired');
    }
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

export const api = {
  get:    (path: string)               => {
    const cached = _recentGets.get(path);
    if (cached && Date.now() - cached.at < GET_CACHE_TTL_MS) {
      return Promise.resolve(cached.value);
    }

    const existing = _inFlightGets.get(path);
    if (existing) return existing;

    const pending = request('GET', path)
      .then((value) => {
        _recentGets.set(path, { at: Date.now(), value });
        if (_recentGets.size > 300) {
          const cutoff = Date.now() - GET_CACHE_TTL_MS;
          for (const [key, entry] of _recentGets) {
            if (entry.at < cutoff) _recentGets.delete(key);
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
