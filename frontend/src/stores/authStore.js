import { create } from 'zustand';
import { api, setToken, getToken } from '../lib/api';
import { wsManager } from '../lib/ws';

export const useAuthStore = create((set, get) => ({
  user:    null,
  authBypass: false,
  loading: true,   // true while checking existing session on mount

  /** Called on app mount – tries to restore session from refresh cookie */
  async init() {
    try {
      if (getToken()) {
        const data = await api.get('/users/me');
        set({ user: data.user, authBypass: false, loading: false });
        wsManager.connect();
        return;
      }
    } catch {
      setToken(null);
    }

    try {
      const data = await api.get('/auth/session');
      if (data?.authBypass && data.user) {
        setToken(data.accessToken || null);
        set({ user: data.user, authBypass: true, loading: false });
        wsManager.connect({ allowAnonymous: true });
        return;
      }
    } catch {
      // Fall through to normal refresh-based session restore.
    }

    try {
      const { accessToken } = await api.post('/auth/refresh');
      setToken(accessToken);
      const data = await api.get('/users/me');
      set({ user: data.user, authBypass: false, loading: false });
      wsManager.connect();
    } catch {
      set({ user: null, authBypass: false, loading: false });
    }
  },

  async login(email, password) {
    const data = await api.post('/auth/login', { email, password });
    setToken(data.accessToken);
    set({ user: data.user, authBypass: false });
    wsManager.connect();
    return data.user;
  },

  async register(email, username, password, displayName) {
    const data = await api.post('/auth/register', { email, username, password, displayName });
    setToken(data.accessToken);
    set({ user: data.user, authBypass: false });
    wsManager.connect();
    return data.user;
  },

  async logout() {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    setToken(null);
    wsManager.disconnect();
    set({ user: null, authBypass: false });
  },
}));
