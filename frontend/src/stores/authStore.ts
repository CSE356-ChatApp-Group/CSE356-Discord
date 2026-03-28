import { create } from 'zustand';
import { api, setToken, getToken } from '../lib/api';
import { wsManager } from '../lib/ws';

type AuthUser = {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  updatedAt?: string;
};

function normalizeAuthUser(user: any): AuthUser {
  if (!user) return user;
  return {
    ...user,
    displayName: user.displayName ?? user.display_name,
    avatarUrl: user.avatarUrl ?? user.avatar_url,
    updatedAt: user.updatedAt ?? user.updated_at,
  };
}

type AuthState = {
  user: AuthUser | null;
  authBypass: boolean;
  loading: boolean;
  setUser: (user: AuthUser | null) => void;
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, username: string, password: string, displayName: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
};

export const useAuthStore = create<AuthState>()((set, get) => ({
  user:    null,
  authBypass: false,
  loading: true,   // true while checking existing session on mount

  setUser(user: AuthUser | null) {
    set({ user: normalizeAuthUser(user) });
  },

  /** Called on app mount – tries to restore session from refresh cookie */
  async init() {
    try {
      if (getToken()) {
        const data = await api.get('/users/me');
        set({ user: normalizeAuthUser(data.user), authBypass: false, loading: false });
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
        set({ user: normalizeAuthUser(data.user), authBypass: true, loading: false });
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
      set({ user: normalizeAuthUser(data.user), authBypass: false, loading: false });
      wsManager.connect();
    } catch {
      set({ user: null, authBypass: false, loading: false });
    }
  },

  async login(email: string, password: string) {
    const data = await api.post('/auth/login', { email, password });
    setToken(data.accessToken);
    set({ user: normalizeAuthUser(data.user), authBypass: false });
    wsManager.connect();
    return normalizeAuthUser(data.user);
  },

  async register(email: string, username: string, password: string, displayName: string) {
    const data = await api.post('/auth/register', { email, username, password, displayName });
    setToken(data.accessToken);
    set({ user: normalizeAuthUser(data.user), authBypass: false });
    wsManager.connect();
    return normalizeAuthUser(data.user);
  },

  async logout() {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    setToken(null);
    wsManager.disconnect();
    set({ user: null, authBypass: false });
  },
}));
