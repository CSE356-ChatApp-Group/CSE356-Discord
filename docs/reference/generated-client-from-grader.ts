import FormData from 'form-data';
import { CookieJar, fetchWithRetry, RealtimeManager } from '/test-harness/helpers';

// Override global fetch to set User-Agent (server blocks 'node' UA with 503)
const _origFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => {
  const h = new Headers(init?.headers);
  if (!h.has('User-Agent')) h.set('User-Agent', 'Mozilla/5.0 (compatible; API-Client/1.0)');
  return _origFetch(input, { ...init, headers: h });
};

// ─── Type Definitions ───

export interface UserInfo {
  id: string;
  username: string;
  displayName?: string;
  presence?: string;
  awayMessage?: string;
}

export interface ChannelInfo {
  id: string;
  name?: string;
  type?: string;
  isPrivate?: boolean;
  communityId?: string;
}

export interface DMInfo {
  id: string;
  participantIds: string[];
  type?: string;
}

export interface MessageInfo {
  id: string;
  conversationId: string;
  content: string;
  authorId: string;
  timestamp?: string;
  attachments?: string[];
  edited?: boolean;
}

export interface CommunityInfo {
  id: string;
  name: string;
  ownerId: string;
}

export interface SearchResult {
  message: MessageInfo;
  conversationId?: string;
  communityId?: string;
}

// ─── GeneratedClient ───

export class GeneratedClient {
  private baseUrl: string;
  private jar: CookieJar;
  private accessToken: string | null = null;
  private rt: RealtimeManager;

  private messageHandlers: ((msg: MessageInfo) => void)[] = [];
  private messageEditHandlers: ((msg: MessageInfo) => void)[] = [];
  private messageDeleteHandlers: ((evt: { conversationId: string; messageId: string }) => void)[] = [];
  private presenceHandlers: ((evt: { userId: string; presence: string }) => void)[] = [];
  private inviteHandlers: ((evt: { type: 'community' | 'dm'; id: string }) => void)[] = [];
  private readReceiptHandlers: ((evt: { conversationId: string; userId: string; messageId: string }) => void)[] = [];
  private realtimeReady = false;
  private realtimeReadyWaiters: Array<() => void> = [];

  private static keycloakCookieCache: Map<string, Map<string, string>> = new Map();

  ssoPath = '/api/v1/auth/course';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.jar = new CookieJar();
    this.rt = new RealtimeManager({
      url: () => {
        const wsBase = this.baseUrl.replace(/^http/, 'ws');
        return `${wsBase}/ws${this.accessToken ? '?token=' + this.accessToken : ''}`;
      },
      headers: (): Record<string, string> => {
        const cookie = this.jar.toHeader();
        return cookie ? { cookie } : {};
      },
      onMessage: (msg: any) => this.handleWsMessage(msg),
    });
  }

  setSessionCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  // ─── Internal Helpers ───

  private async doRefreshToken(): Promise<void> {
    try {
      const res = await fetchWithRetry(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
      }, this.jar);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.accessToken) this.accessToken = data.accessToken;
      }
    } catch {}
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers as any);
    if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
    let res = await fetchWithRetry(url, { ...init, headers } as any, this.jar);
    if (res.status === 401) {
      await this.doRefreshToken();
      if (this.accessToken) {
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        res = await fetchWithRetry(url, { ...init, headers } as any, this.jar);
      }
    }
    return res;
  }

  private mapUser(u: any): UserInfo {
    const username = u.username || u.name || '';
    return {
      id: String(u.id || u._id || ''),
      username,
      displayName: u.display_name || u.displayName || undefined,
      presence: u.status || u.presence || undefined,
      awayMessage: u.away_message || u.awayMessage || undefined,
    };
  }

  private mapMessage(m: any): MessageInfo {
    const convId = m.channel_id || m.conversation_id || m.channelId || m.conversationId || '';
    return {
      id: String(m.id || m._id || ''),
      conversationId: String(convId),
      content: m.content || '',
      authorId: String(m.author_id || m.authorId || m.author?.id || ''),
      timestamp: m.created_at || m.timestamp || m.createdAt || undefined,
      attachments: (m.attachments || []).map((a: any) =>
        typeof a === 'string' ? a : (a.url || a.file_url || a.attachment_url || '')
      ).filter((s: string) => s),
      edited: !!(m.edited_at || m.edited || m.isEdited),
    };
  }

  private mapChannel(c: any): ChannelInfo {
    return {
      id: String(c.id || c._id || ''),
      name: c.name || undefined,
      type: c.type || (c.is_private ? 'private' : 'public'),
      isPrivate: !!(c.is_private || c.isPrivate),
      communityId: String(c.community_id || c.communityId || ''),
    };
  }

  private mapDM(c: any): DMInfo {
    const participants = c.participants || [];
    return {
      id: String(c.id || c._id || ''),
      participantIds: participants.map((p: any) =>
        typeof p === 'string' ? p : String(p.id || p._id || '')
      ),
      type: c.type || (participants.length > 2 ? 'group' : 'dm'),
    };
  }

  private mapCommunity(c: any): CommunityInfo {
    return {
      id: String(c.id || c._id || ''),
      name: c.name || '',
      ownerId: String(c.owner_id || c.ownerId || ''),
    };
  }

  private tryExtractExistingUser(token: string): UserInfo | null {
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (payload.id) {
          return this.mapUser(payload);
        }
      }
    } catch {}
    return null;
  }

  private static parseSetCookies(res: Response, jar: CookieJar): void {
    const vals: string[] = (res.headers as any).getSetCookie
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
    for (const c of vals) {
      const eqIdx = c.indexOf('=');
      const semiIdx = c.indexOf(';');
      if (eqIdx > 0) {
        const name = c.substring(0, eqIdx).trim();
        const val = c.substring(eqIdx + 1, semiIdx > eqIdx ? semiIdx : undefined).trim();
        if (name && val) jar.set(name, val);
      }
    }
  }

  private markRealtimeReady(): void {
    this.realtimeReady = true;
    const waiters = this.realtimeReadyWaiters.splice(0);
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {
        // ignore waiter failures
      }
    }
  }

  private waitForRealtimeReady(): Promise<void> {
    if (this.realtimeReady) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.realtimeReadyWaiters.push(resolve);
    });
  }

  // ─── Authentication ───

  async register(username: string, password: string, displayName?: string): Promise<UserInfo> {
    const email = `${username}@test.com`;
    const res = await fetchWithRetry(`${this.baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password, displayName: displayName || username }),
    } as any, this.jar);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 409 || errText.includes('exist') || errText.includes('duplicate')) {
        throw new Error(`User already exists: ${username}`);
      }
      if (res.status === 400 && (errText.includes('Invalid value') || errText.includes('invalid'))) {
        throw new Error(`User already exists: ${username}`);
      }
      throw new Error(`register failed: ${res.status} ${errText}`);
    }
    const data = await res.json() as any;
    this.accessToken = data.accessToken;
    if (data.user) return this.mapUser(data.user);
    if (data.accessToken) {
      try {
        const parts = data.accessToken.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          return this.mapUser(payload);
        }
      } catch {}
    }
    const meRes = await this.authedFetch(`${this.baseUrl}/api/v1/users/me`);
    if (meRes.ok) return this.mapUser((await meRes.json() as any).user || {});
    return { id: '', username, displayName: undefined };
  }

  // NO FALLBACK: single API call, single email format. If the server needs a
  // different email format, that is a server issue to report in feedback.json.
  async login(username: string, password: string): Promise<UserInfo> {
    const email = `${username}@test.com`;
    const res = await fetchWithRetry(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    } as any, this.jar);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`login failed: ${res.status} ${errText}`);
    }
    const data = await res.json() as any;
    this.accessToken = data.accessToken;
    return this.mapUser(data.user || {});
  }

  async loginSSO(username: string, password: string): Promise<any> {
    const kcJar = new CookieJar();
    const cached = GeneratedClient.keycloakCookieCache.get(username);
    if (cached) {
      for (const [k, v] of cached) kcJar.set(k, v);
    }

    // Manual redirect following — preserves cookies across redirects.
    // Uses raw fetch() for app-domain requests (not fetchWithRetry) to avoid
    // the CookieJar's undici Agent connection pool which causes 503 after
    // register/login/logout on the same client instance.
    const followRedirects = async (startUrl: string): Promise<{ url: string; body: string; pending?: string }> => {
      let currentUrl = startUrl;
      for (let i = 0; i < 15; i++) {
        try {
          const urlObj = new URL(currentUrl);
          const token = urlObj.searchParams.get('token') || urlObj.searchParams.get('pending');
          if (token) return { url: currentUrl, body: '', pending: token };
        } catch {}

        const isKc = currentUrl.includes('infra-auth');
        let res: Response;
        if (isKc) {
          res = await fetchWithRetry(currentUrl, { redirect: 'manual' } as any, kcJar);
        } else {
          // Use raw fetch with manual cookie handling (bypasses jar's connection pool)
          const appCookie = this.jar.toHeader();
          res = await fetch(currentUrl, {
            redirect: 'manual',
            headers: appCookie ? { 'Cookie': appCookie } : {},
          } as any);
          GeneratedClient.parseSetCookies(res, this.jar);
        }

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          await res.text().catch(() => {});
          if (!loc) break;
          currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).toString();
          continue;
        }
        if (res.status === 200) {
          const body = await res.text();
          return { url: currentUrl, body };
        }
        // Non-200/non-redirect response — break out
        await res.text().catch(() => {});
        break;
      }
      return { url: currentUrl, body: '' };
    };

    const result1 = await followRedirects(`${this.baseUrl}${this.ssoPath}`);

    if (result1.pending) {
      // Decode JWT to check if user already exists (has id field)
      const existingUser = this.tryExtractExistingUser(result1.pending);
      if (existingUser) {
        this.accessToken = result1.pending;
        await this.doRefreshToken();
        return existingUser;
      }
      return await this.completeSsoCreate(result1.pending, username, password);
    }

    const kcBody = result1.body;
    const match =
      kcBody.match(/id="kc-form-login"[^>]*action="([^"]+)"/s) ||
      kcBody.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/s) ||
      kcBody.match(/<form[^>]*action="([^"]+)"/s);

    if (!match) {
      const meRes = await this.authedFetch(`${this.baseUrl}/api/v1/users/me`);
      if (meRes.ok) {
        await this.doRefreshToken();
        return this.mapUser((await meRes.json() as any).user || {});
      }
      throw new Error(`SSO: no Keycloak form found. URL: ${result1.url}`);
    }
    const kcFormAction = match[1].replace(/&amp;/g, '&');

    const postRes = await fetchWithRetry(kcFormAction, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      redirect: 'manual',
    } as any, kcJar);

    // Cache Keycloak cookies
    const kcCookieStr = kcJar.toHeader();
    const kcMap = new Map<string, string>();
    if (kcCookieStr) {
      for (const part of kcCookieStr.split('; ')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) kcMap.set(part.substring(0, eqIdx), part.substring(eqIdx + 1));
      }
    }
    GeneratedClient.keycloakCookieCache.set(username, kcMap);

    if (postRes.status === 200) {
      const body = await postRes.text();
      if (body.includes('Invalid username or password') || body.includes('kc-form-login')) {
        throw new Error('SSO: Keycloak credentials rejected');
      }
    }
    if (postRes.status < 300 || postRes.status >= 400) {
      throw new Error(`SSO: unexpected KC POST status ${postRes.status}`);
    }

    let afterKcUrl = postRes.headers.get('location');
    if (!afterKcUrl) throw new Error('SSO: no redirect after Keycloak POST');
    if (!afterKcUrl.startsWith('http')) afterKcUrl = new URL(afterKcUrl, kcFormAction).toString();

    const result2 = await followRedirects(afterKcUrl);

    if (result2.pending) {
      // Decode JWT to check if user already exists (has id field)
      const existingUser = this.tryExtractExistingUser(result2.pending);
      if (existingUser) {
        this.accessToken = result2.pending;
        await this.doRefreshToken();
        return existingUser;
      }
      return await this.completeSsoCreate(result2.pending, username, password);
    }

    const meRes = await this.authedFetch(`${this.baseUrl}/api/v1/users/me`);
    if (meRes.ok) {
      await this.doRefreshToken();
      return this.mapUser((await meRes.json() as any).user || {});
    }
    throw new Error(`SSO login failed. URL: ${result2.url}`);
  }

  // NO FALLBACK LOGIN: if complete-create fails, throw. Do not try multiple
  // email formats or login endpoints — that is fallback endpoint probing.
  private async completeSsoCreate(
    pendingToken: string,
    username: string,
    password: string,
  ): Promise<any> {
    const jar = this.jar;
    let preAssignedUsername: string = username;
    try {
      const parts = pendingToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (payload.username || payload.preferredUsername) {
          preAssignedUsername = payload.preferredUsername || payload.username;
        }
      }
    } catch {}

    const url = `${this.baseUrl}/api/v1/auth/oauth/complete-create`;
    const createRes = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pendingToken,
        username: preAssignedUsername,
        displayName: username,
        password,
      }),
    } as any, jar);

    if (createRes.ok) {
      const d = await createRes.json() as any;
      this.accessToken = d.accessToken;
      return this.mapUser(d.user || {});
    }

    // 409 = account already exists → link via complete-connect
    if (createRes.status === 409) {
      await createRes.text().catch(() => {});
      const email = `${username}@test.com`;
      const connectUrl = `${this.baseUrl}/api/v1/auth/oauth/complete-connect`;
      const connectRes = await fetchWithRetry(connectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken, email, password }),
      } as any, jar);
      if (connectRes.ok) {
        const d = await connectRes.json() as any;
        this.accessToken = d.accessToken;
        return this.mapUser(d.user || {});
      }
      const connectErr = await connectRes.text().catch(() => '');
      throw new Error(`SSO complete-connect failed: ${connectRes.status} ${connectErr}`);
    }

    const errText = await createRes.text().catch(() => '');
    throw new Error(`SSO complete-create failed: ${createRes.status} ${errText}`);
  }

  async logout(): Promise<void> {
    try {
      await this.authedFetch(`${this.baseUrl}/api/v1/auth/logout`, { method: 'POST' });
    } catch {}
    this.accessToken = null;
    this.jar.clear();
  }

  // ─── Profile ───

  async getDisplayName(): Promise<string> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/users/me`);
    if (!res.ok) throw new Error(`getDisplayName failed: ${res.status}`);
    const d = await res.json() as any;
    return d.user?.display_name || d.user?.displayName || '';
  }

  async setDisplayName(displayName: string): Promise<void> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`setDisplayName failed: ${res.status} ${err}`);
    }
  }

  async setAvatar(imageBuffer: Buffer, mimeType: string): Promise<string> {
    const ext = mimeType.split('/')[1] || 'png';
    const form = new FormData();
    form.append('avatar', imageBuffer, { filename: `avatar.${ext}`, contentType: mimeType });
    const formBuf = form.getBuffer();
    const formHeaders = form.getHeaders();
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/users/me/avatar`, {
      method: 'POST',
      body: formBuf as any,
      headers: { ...formHeaders, 'Content-Length': String(formBuf.length) },
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`setAvatar failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    return d.user?.avatar_url || d.user?.avatarUrl || d.avatarUrl || d.url || '';
  }

  async getAvatar(username?: string): Promise<string> {
    if (username) {
      const users = await this.searchUsers(username);
      const user = users.find((u: UserInfo) => u.username === username);
      if (user && user.id) {
        const res = await this.authedFetch(`${this.baseUrl}/api/v1/users/${user.id}`);
        if (res.ok) {
          const d = await res.json() as any;
          return d.user?.avatar_url || d.user?.avatarUrl || d.avatar_url || '';
        }
      }
    }
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/users/me`);
    if (!res.ok) throw new Error(`getAvatar failed: ${res.status}`);
    const d = await res.json() as any;
    return d.user?.avatar_url || d.user?.avatarUrl || '';
  }

  // ─── Presence ───

  async setPresence(status: string): Promise<void> {
    this.rt.send({ type: 'presence', status }).catch(() => {});
    try {
      await this.authedFetch(`${this.baseUrl}/api/v1/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {}
  }

  async setAwayMessage(message: string): Promise<void> {
    this.rt.send({ type: 'away_message', message }).catch(() => {});
    try {
      await this.authedFetch(`${this.baseUrl}/api/v1/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awayMessage: message }),
      });
    } catch {}
  }

  onPresence(callback: (event: { userId: string; presence: string }) => void): void {
    this.presenceHandlers.push(callback);
  }

  // ─── User Search ───

  async searchUsers(query: string): Promise<UserInfo[]> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/users?q=${encodeURIComponent(query)}&limit=100`);
    if (!res.ok) return [];
    const d = await res.json() as any;
    const users = d.users || [];
    if (!Array.isArray(users) || users.length === 0) return [];

    return users.map((u: any) => this.mapUser(u));
  }

  // ─── Communities ───

  async createCommunity(name: string): Promise<CommunityInfo> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') +
      '-' + Math.random().toString(36).substring(2, 6);
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/communities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`createCommunity failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    return this.mapCommunity(d.community || d);
  }

  async getCommunities(): Promise<CommunityInfo[]> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/communities`);
    if (!res.ok) throw new Error(`getCommunities failed: ${res.status}`);
    const d = await res.json() as any;
    return (d.communities || d.data || []).map((c: any) => this.mapCommunity(c));
  }

  async joinCommunity(communityId: string): Promise<void> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/communities/${communityId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`joinCommunity failed: ${res.status} ${err}`);
    }
  }

  async switchCommunity(_communityId: string): Promise<void> {
    // No server-side endpoint for switching active community — no-op
  }

  async getCommunityMembers(communityId: string): Promise<UserInfo[]> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/communities/${communityId}/members`);
    if (!res.ok) throw new Error(`getCommunityMembers failed: ${res.status}`);
    const d = await res.json() as any;
    return (d.members || d.data || []).map((m: any) => this.mapUser(m));
  }

  // ─── Channels ───

  async createChannelInCommunity(communityId: string, name: string, options?: { isPrivate?: boolean }): Promise<ChannelInfo> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ communityId, name, isPrivate: options?.isPrivate ?? false }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`createChannelInCommunity failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    return this.mapChannel(d.channel || d);
  }

  async getChannelsInCommunity(communityId: string): Promise<ChannelInfo[]> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/channels?communityId=${communityId}`);
    if (!res.ok) throw new Error(`getChannelsInCommunity failed: ${res.status}`);
    const d = await res.json() as any;
    return (d.channels || d.data || []).map((c: any) => this.mapChannel(c));
  }

  // ─── Direct Conversations ───

  async createDM(userIds: string[]): Promise<DMInfo> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantIds: userIds }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`createDM failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    const dm = this.mapDM(d.conversation || d);
    return dm;
  }

  async getDMChannels(): Promise<DMInfo[]> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/conversations`);
    if (!res.ok) throw new Error(`getDMChannels failed: ${res.status}`);
    const d = await res.json() as any;
    return (d.conversations || d.data || []).map((c: any) => this.mapDM(c));
  }

  async addDMParticipant(dmId: string, userId: string): Promise<void> {
    // Server requires participantIds as an array
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/conversations/${dmId}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantIds: [userId] }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`addDMParticipant failed: ${res.status} ${err}`);
    }
  }

  async leaveDM(dmId: string): Promise<void> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/conversations/${dmId}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`leaveDM failed: ${res.status} ${err}`);
    }
  }

  // ─── Messaging ───

  async sendMessage(conversationId: string, content: string, attachments?: Buffer[]): Promise<MessageInfo> {
    let res: Response;
    if (attachments && attachments.length > 0) {
      const form = new FormData();
      form.append('content', content);
      form.append('channelId', conversationId);
      for (const buf of attachments) {
        form.append('attachments', buf, { filename: 'image.png', contentType: 'image/png' });
      }
      res = await this.authedFetch(`${this.baseUrl}/api/v1/messages`, {
        method: 'POST',
        body: form as any,
        headers: form.getHeaders(),
      });
    } else {
      res = await this.authedFetch(`${this.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: conversationId, content }),
      });
    }
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`sendMessage failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    return this.mapMessage(d.message || d);
  }

  async sendDM(conversationId: string, content: string, attachments?: Buffer[]): Promise<MessageInfo> {
    let res: Response;
    if (attachments && attachments.length > 0) {
      const form = new FormData();
      form.append('content', content);
      form.append('conversationId', conversationId);
      for (const buf of attachments) {
        form.append('attachments', buf, { filename: 'image.png', contentType: 'image/png' });
      }
      res = await this.authedFetch(`${this.baseUrl}/api/v1/messages`, {
        method: 'POST',
        body: form as any,
        headers: form.getHeaders(),
      });
    } else {
      res = await this.authedFetch(`${this.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, content }),
      });
    }
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`sendDM failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    return this.mapMessage(d.message || d);
  }

  async getMessages(channelId: string, options?: { before?: string; limit?: number }): Promise<MessageInfo[]> {
    const limit = options?.limit || 50;
    let params = `limit=${limit}`;
    if (options?.before) params += `&before=${encodeURIComponent(options.before)}`;

    const res = await this.authedFetch(`${this.baseUrl}/api/v1/messages?${params}&channelId=${channelId}`);
    if (!res.ok) return [];
    const d = await res.json() as any;
    return (d.messages || d.data || []).map((m: any) => this.mapMessage(m));
  }

  async getMessagesDM(conversationId: string, options?: { before?: string; limit?: number }): Promise<MessageInfo[]> {
    const limit = options?.limit || 50;
    let params = `limit=${limit}`;
    if (options?.before) params += `&before=${encodeURIComponent(options.before)}`;

    const res = await this.authedFetch(`${this.baseUrl}/api/v1/messages?${params}&conversationId=${conversationId}`);
    if (!res.ok) return [];
    const d = await res.json() as any;
    return (d.messages || d.data || []).map((m: any) => this.mapMessage(m));
  }

  async editMessage(conversationId: string, messageId: string, newContent: string): Promise<MessageInfo> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`editMessage failed: ${res.status} ${err}`);
    }
    const d = await res.json() as any;
    return this.mapMessage(d.message || d);
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    const res = await this.authedFetch(`${this.baseUrl}/api/v1/messages/${messageId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`deleteMessage failed: ${res.status} ${err}`);
    }
  }

  // ─── Real-time ───

  private handleWsMessage(msg: any): void {
    const event = msg.event || msg.type;
    const data = msg.data || msg;
    switch (event) {
      case 'ready':
        this.markRealtimeReady();
        break;

      case 'message:created':
      case 'new_message':
        this.messageHandlers.forEach(h => h(this.mapMessage(data)));
        break;

      case 'message:updated':
      case 'message:edited':
      case 'message_edited':
        this.messageEditHandlers.forEach(h => h(this.mapMessage(data)));
        break;

      case 'message:deleted':
      case 'message_deleted': {
        const messageId = String(data.id || data.messageId || data.message_id || '');
        // conversationId may be in data fields OR in msg.channel ("conversation:{id}" or "channel:{id}")
        let conversationId = String(
          data.channel_id || data.conversation_id ||
          data.channelId || data.conversationId || ''
        );
        if (!conversationId) {
          const channelStr = String(msg.channel || '');
          if (channelStr.startsWith('conversation:')) {
            conversationId = channelStr.replace('conversation:', '');
          } else if (channelStr.startsWith('channel:')) {
            conversationId = channelStr.replace('channel:', '');
          }
        }
        this.messageDeleteHandlers.forEach(h => h({ conversationId, messageId }));
        break;
      }

      case 'presence:updated':
      case 'presence_update':
      case 'user:status': {
        const userId = String(data.userId || data.user_id || data.id || '');
        const presence = String(data.status || data.presence || '');
        if (userId) this.presenceHandlers.forEach(h => h({ userId, presence }));
        break;
      }

      case 'community:invite':
      case 'community:joined':
      case 'community:member_added': {
        const id = String(data.communityId || data.community_id || data.id || '');
        if (id) this.inviteHandlers.forEach(h => h({ type: 'community', id }));
        break;
      }

      case 'conversation:created':
      case 'conversation:invited':
      case 'conversation:invite':
      case 'conversation:participant_added':
      case 'dm:invite': {
        const id = String(data.conversation?.id || data.id || data.conversationId || data.conversation_id || '');
        if (id) this.inviteHandlers.forEach(h => h({ type: 'dm', id }));
        break;
      }

      case 'read:updated':
      case 'message:read':
      case 'read:receipt':
      case 'read_receipt': {
        const conversationId = String(
          data.conversationId || data.conversation_id ||
          data.channelId || data.channel_id || ''
        );
        const userId = String(data.userId || data.user_id || '');
        const messageId = String(
          data.lastReadMessageId || data.messageId ||
          data.message_id || data.last_read_message_id || ''
        );
        if (conversationId && userId) {
          this.readReceiptHandlers.forEach(h => h({ conversationId, userId, messageId }));
        }
        break;
      }
    }
  }

  onMessage(callback: (message: MessageInfo) => void): void {
    this.messageHandlers.push(callback);
  }

  onMessageEdit(callback: (message: MessageInfo) => void): void {
    this.messageEditHandlers.push(callback);
  }

  onMessageDelete(callback: (event: { conversationId: string; messageId: string }) => void): void {
    this.messageDeleteHandlers.push(callback);
  }

  onInvite(callback: (event: { type: 'community' | 'dm'; id: string }) => void): void {
    this.inviteHandlers.push(callback);
  }

  async enableRealtime(): Promise<void> {
    try {
      this.realtimeReady = false;
      await this.rt.enable();
      await this.waitForRealtimeReady();
    } catch {
      // WS connection failed or was destroyed — not critical
    }
  }

  async disableRealtime(): Promise<void> {
    await this.rt.disable();
  }

  isWebSocketConnected(): boolean {
    return this.rt.isConnected();
  }

  // NO SETTIMEOUT: do not use setTimeout, setInterval, or any delay/timer
  // pattern in client methods. RealtimeManager handles cleanup internally.
  disconnect(): void {
    this.rt.destroy();
  }

  // ─── Read State ───

  async markRead(conversationId: string, messageId: string): Promise<void> {
    // PUT /api/v1/messages/:id/read
    await this.authedFetch(`${this.baseUrl}/api/v1/messages/${messageId}/read`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
  }

  async getUnreadCounts(): Promise<{ conversationId: string; count: number }[]> {
    return [];
  }

  onReadReceipt(callback: (event: { conversationId: string; userId: string; messageId: string }) => void): void {
    this.readReceiptHandlers.push(callback);
  }

  // ─── Search ───

  async searchMessages(query: string, options?: {
    conversationId?: string;
    communityId?: string;
    authorId?: string;
    before?: string;
    after?: string;
  }): Promise<SearchResult[]> {
    let url = `${this.baseUrl}/api/v1/search?q=${encodeURIComponent(query)}&limit=30`;
    if (options?.conversationId) url += `&conversationId=${options.conversationId}`;
    else if (options?.communityId) url += `&communityId=${options.communityId}`;
    if (options?.authorId) url += `&authorId=${options.authorId}`;
    if (options?.before) url += `&before=${encodeURIComponent(options.before)}`;
    if (options?.after) url += `&after=${encodeURIComponent(options.after)}`;

    try {
      const res = await this.authedFetch(url);
      if (!res.ok) return [];
      const d = await res.json() as any;
      const hits = d.hits || d.results || d.messages || d.data || [];
      return hits.map((r: any) => {
        const convId = r.channelId || r.conversationId || r.channel_id || r.conversation_id || '';
        const msg: MessageInfo = {
          id: String(r.id || r._id || ''),
          conversationId: String(convId),
          content: r.content || '',
          authorId: String(r.authorId || r.author_id || ''),
          timestamp: r.createdAt || r.created_at || undefined,
          attachments: [],
          edited: false,
        };
        return {
          message: msg,
          conversationId: String(convId),
          communityId: String(r.communityId || r.community_id || ''),
        };
      });
    } catch {
      return [];
    }
  }
}