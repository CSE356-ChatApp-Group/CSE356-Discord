import { create } from 'zustand';
import { api, setToken, getToken } from '../lib/api';
import { wsManager } from '../lib/ws';
import { resetChatStore } from './chatStore';

type AuthUser = {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  updatedAt?: string;
  status?: 'online' | 'idle' | 'away' | 'offline';
  awayMessage?: string | null;
};

function normalizeAuthUser(user: any): AuthUser {
  if (!user) return user;
  return {
    ...user,
    displayName: user.displayName ?? user.display_name,
    avatarUrl: user.avatarUrl ?? user.avatar_url,
    updatedAt: user.updatedAt ?? user.updated_at,
    status: user.status,
    awayMessage: user.awayMessage ?? user.away_message ?? null,
  };
}

type AuthState = {
  user: AuthUser | null;
  authBypass: boolean;
  loading: boolean;
  setUser: (user: AuthUser | null) => void;
  expireSession: () => void;
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string | null | undefined, username: string, password: string, displayName: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
};

let initInFlight: Promise<void> | null = null;

function isAuthRoute(pathname: string) {
  return pathname === '/login' || pathname === '/register' || pathname === '/oauth-callback';
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user:    null,
  authBypass: false,
  loading: true,   // true while checking existing session on mount

  setUser(user: AuthUser | null) {
    if (user && !getToken() && !get().authBypass) {
      // Ignore stale profile writes that arrive after logout/session expiry.
      return;
    }
    set({ user: normalizeAuthUser(user) });
  },

  expireSession() {
    setToken(null);
    wsManager.disconnect();
    resetChatStore();
    set({ user: null, authBypass: false, loading: false });
  },

  /** Called on app mount – tries to restore session from refresh cookie */
  async init() {
    if (!get().loading) return;
    if (initInFlight) return initInFlight;

    initInFlight = (async () => {
    const currentPath = window.location.pathname;
    const oauthParams = new URLSearchParams(window.location.search);

    // Avoid racing the OAuth callback bootstrap. That route sets the token from
    // the URL first, then calls init() again to hydrate the user profile.
    if (currentPath === '/oauth-callback' && !getToken() && (oauthParams.has('token') || oauthParams.has('pending'))) {
      return;
    }

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

    if (!isAuthRoute(currentPath)) {
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
    })();

    try {
      await initInFlight;
    } finally {
      initInFlight = null;
    }
  },

  async login(email: string, password: string) {
    const data = await api.post('/auth/login', { email, password });
    setToken(data.accessToken);
    let user = normalizeAuthUser(data.user);
    if (!user?.id) {
      try {
        const profile = await api.get('/users/me');
        if (profile?.user) user = normalizeAuthUser(profile.user);
      } catch {
        // Fall back to auth payload if profile hydrate fails.
      }
    }
    set({ user, authBypass: false });
    wsManager.connect();
    return user;
  },

  async register(email: string | null | undefined, username: string, password: string, displayName: string) {
    const data = await api.post('/auth/register', { email: email || undefined, username, password, displayName });
    setToken(data.accessToken);
    let user = normalizeAuthUser(data.user);
    if (!user?.id) {
      try {
        const profile = await api.get('/users/me');
        if (profile?.user) user = normalizeAuthUser(profile.user);
      } catch {
        // Fall back to auth payload if profile hydrate fails.
      }
    }
    set({ user, authBypass: false });
    wsManager.connect();
    return user;
  },

  async logout() {
    const revokeSession = api.post('/auth/logout').catch(() => null);
    get().expireSession();
    await revokeSession;
  },
}));
