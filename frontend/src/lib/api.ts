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
// Remove any stale token left from the previous localStorage-based approach.
localStorage.removeItem('accessToken');
let _refreshing   = null; // in-flight refresh promise

export function setToken(t: string | null) {
  _accessToken = t;
}

export function getToken() { return _accessToken; }

async function requestFormData(path: string, formData: FormData) {
  const headers: Record<string, string> = {};
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

  const res = await fetch(`${BASE}${path}`, {
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
  const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
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

  const res = await fetch(`${BASE}${path}`, {
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
      setToken(null);
      const currentPath = window.location.pathname;
      const isAuthRoute = currentPath === '/login' || currentPath === '/register' || currentPath === '/oauth-callback';
      if (!isAuthRoute) {
        window.location.href = '/login';
      }
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
  get:    (path: string)               => request('GET',    path),
  post:   (path: string, body?: unknown) => request('POST',   path, body),
  postForm: (path: string, formData: FormData) => requestFormData(path, formData),
  patch:  (path: string, body?: unknown) => request('PATCH',  path, body),
  put:    (path: string, body?: unknown) => request('PUT',    path, body),
  delete: (path: string)               => request('DELETE', path),
};
