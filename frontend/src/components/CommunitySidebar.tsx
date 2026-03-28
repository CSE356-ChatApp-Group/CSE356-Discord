import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { api } from '../lib/api';
import Modal from './Modal';
import styles from './CommunitySidebar.module.css';

export default function CommunitySidebar() {
  const { communities, activeCommunity, selectCommunity, createCommunity, fetchCommunities, openHome } = useChatStore();
  const logout = useAuthStore(s => s.logout);
  const user   = useAuthStore(s => s.user);
  const setUser = useAuthStore(s => s.setUser);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [linkedProviders, setLinkedProviders] = useState<string[]>([]);
  const [hasPassword, setHasPassword] = useState(false);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linkBusyProvider, setLinkBusyProvider] = useState<string | null>(null);
  const [accountError, setAccountError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ newPassword: '', confirmPassword: '' });
  const [passwordMsg, setPasswordMsg] = useState('');
  const [presenceStatus, setPresenceStatus] = useState<'online' | 'away'>('online');
  const [awayMessage, setAwayMessage] = useState('');
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [presenceMsg, setPresenceMsg] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState('');
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  async function openAccountModal() {
    setShowAccount(true);
    setAccountError('');
    setLoadingLinks(true);
    try {
      const data = await api.get('/auth/oauth/linked');
      setLinkedProviders(Array.isArray(data?.providers) ? data.providers : []);
      setHasPassword(Boolean(data?.hasPassword));
      const me = await api.get('/users/me');
      const status = me?.user?.status === 'away' ? 'away' : 'online';
      setPresenceStatus(status);
      setAwayMessage(me?.user?.away_message || me?.user?.awayMessage || '');
      setPresenceMsg('');
    } catch (e) {
      setAccountError(e?.message || 'Could not load linked providers');
      setLinkedProviders([]);
      setHasPassword(false);
      setPresenceStatus('online');
      setAwayMessage('');
    } finally {
      setLoadingLinks(false);
    }
  }

  async function submitPresence(e) {
    e.preventDefault();
    setPresenceBusy(true);
    setPresenceMsg('');
    setAccountError('');
    try {
      const body = presenceStatus === 'away'
        ? { status: 'away', awayMessage: awayMessage.trim() || null }
        : { status: 'online', awayMessage: null };
      await api.put('/presence', body);
      setPresenceMsg(presenceStatus === 'away' ? 'Away status updated.' : 'Presence set to online.');
      const profile = await api.get('/users/me');
      if (profile?.user) setUser(profile.user);
    } catch (e) {
      setAccountError(e?.message || 'Could not update presence');
    } finally {
      setPresenceBusy(false);
    }
  }

  async function startLinkFlow(provider) {
    setAccountError('');
    setLinkBusyProvider(provider);
    try {
      const data = await api.post('/auth/oauth/link-intent', { provider });
      if (!data?.authUrl) throw new Error('Missing OAuth link URL');
      window.location.href = data.authUrl;
    } catch (e) {
      setAccountError(e?.message || 'Could not start provider linking');
      setLinkBusyProvider(null);
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    setPasswordMsg('');
    setAccountError('');

    if (passwordForm.newPassword.length < 8) {
      setAccountError('Password must be at least 8 characters.');
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setAccountError('Password confirmation does not match.');
      return;
    }

    setPasswordBusy(true);
    try {
      await api.patch('/users/me', { password: passwordForm.newPassword });
      setHasPassword(true);
      setPasswordForm({ newPassword: '', confirmPassword: '' });
      setPasswordMsg('Password updated. You can now use local email/password login.');
    } catch (e) {
      setAccountError(e?.message || 'Could not update password');
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleAvatarPicked(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setAccountError('');
    setAvatarMsg('');

    if (!file.type.startsWith('image/')) {
      setAccountError('Please choose an image file.');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAccountError('Image must be 5MB or smaller.');
      e.target.value = '';
      return;
    }

    setAvatarBusy(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const data = await api.postForm('/users/me/avatar', formData);
      if (data?.user) setUser(data.user);
      setAvatarMsg('Avatar updated.');
    } catch (err) {
      setAccountError(err?.message || 'Could not upload avatar');
    } finally {
      setAvatarBusy(false);
      e.target.value = '';
    }
  }

  return (
    <nav className={styles.sidebar} aria-label="Communities" data-testid="community-sidebar">
      <div className={styles.topRail}>
        <button
          className={`${styles.icon} ${!activeCommunity ? styles.active : ''}`}
          title="Direct Messages"
          aria-label="Open direct messages home"
          data-testid="home-dms-open"
          onClick={openHome}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <div className={styles.separator} />
      </div>

      {/* Community icons */}
      <div className={styles.list} data-testid="community-list">
        {communities.filter(c => c.my_role).map(c => (
          <CommunityIcon
            key={c.id}
            community={c}
            unread={communityHasUnreadChannels(c)}
            active={activeCommunity?.id === c.id}
            onClick={() => selectCommunity(c)}
          />
        ))}

        <button
          className={styles.addBtn}
          title="Create community"
          aria-label="Create community"
          data-testid="community-create-open"
          onClick={() => setShowCreate(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>

        <button
          className={styles.addBtn}
          title="Browse & join communities"
          aria-label="Browse and join communities"
          data-testid="community-join-open"
          onClick={() => setShowJoin(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </button>
      </div>

      {/* User avatar at bottom */}
      <div className={styles.bottom}>
        <button className={styles.userBtn} title={`${user?.username} – account settings`} onClick={openAccountModal} aria-label="Open account settings" data-testid="account-open">
          <Avatar user={user} name={user?.displayName || user?.username} size={36} />
        </button>
      </div>

      {showCreate && (
        <CreateCommunityModal
          onClose={() => setShowCreate(false)}
          onCreate={async (slug, name, desc) => {
            const c = await createCommunity(slug, name, desc);
            selectCommunity(c);
            setShowCreate(false);
          }}
        />
      )}

      {showJoin && (
        <JoinCommunityModal
          onClose={() => setShowJoin(false)}
          onJoined={async (community) => {
            await fetchCommunities();
            selectCommunity(community);
            setShowJoin(false);
          }}
        />
      )}

      {showAccount && (
        <Modal title="Account" onClose={() => setShowAccount(false)}>
          <div className={styles.accountWrap}>
            <div className={styles.accountIdentity} data-testid="account-identity">
              <Avatar user={user} name={user?.displayName || user?.username} size={44} />
              <div>
                <p className={styles.accountName}>{user?.displayName || user?.username}</p>
                <p className={styles.accountEmail}>{user?.email || 'No email available'}</p>
              </div>
            </div>

            <div>
              <p className={styles.accountSectionTitle}>Avatar</p>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className={styles.hiddenFileInput}
                onChange={handleAvatarPicked}
                data-testid="account-avatar-file"
              />
              <button
                type="button"
                className={styles.linkBtn}
                disabled={avatarBusy}
                onClick={() => avatarInputRef.current?.click()}
                data-testid="account-avatar-upload"
              >
                {avatarBusy ? 'Uploading…' : 'Upload avatar'}
              </button>
              {avatarMsg && <p className={styles.passwordMsg}>{avatarMsg}</p>}
            </div>

            <div>
              <p className={styles.accountSectionTitle}>Presence</p>
              <form className={styles.passwordForm} onSubmit={submitPresence} data-testid="account-presence-form">
                <select
                  value={presenceStatus}
                  onChange={e => setPresenceStatus(e.target.value === 'away' ? 'away' : 'online')}
                  data-testid="account-presence-status"
                >
                  <option value="online">Online / Auto idle</option>
                  <option value="away">Away</option>
                </select>
                {presenceStatus === 'away' && (
                  <input
                    value={awayMessage}
                    onChange={e => setAwayMessage(e.target.value.slice(0, 280))}
                    placeholder="Away message (optional)"
                    data-testid="account-away-message"
                  />
                )}
                <button type="submit" className={styles.passwordBtn} disabled={presenceBusy} data-testid="account-presence-save">
                  {presenceBusy ? 'Saving…' : 'Save presence'}
                </button>
              </form>
              {presenceMsg && <p className={styles.passwordMsg}>{presenceMsg}</p>}
            </div>

            <div>
              <p className={styles.accountSectionTitle}>Connected providers</p>
              {loadingLinks ? (
                <p className={styles.accountMuted}>Loading providers…</p>
              ) : linkedProviders.length ? (
                <p className={styles.accountConnected}>{linkedProviders.join(', ')}</p>
              ) : (
                <p className={styles.accountMuted}>No providers linked yet.</p>
              )}
            </div>

            <div>
              <p className={styles.accountSectionTitle}>Local password</p>
              <p className={styles.accountMuted}>{hasPassword ? 'Configured' : 'Not configured'}</p>
              <form className={styles.passwordForm} onSubmit={submitPassword} data-testid="account-password-form">
                <input
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  placeholder="New password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  data-testid="account-password-new"
                />
                <input
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  data-testid="account-password-confirm"
                />
                <button type="submit" className={styles.passwordBtn} disabled={passwordBusy} data-testid="account-password-save">
                  {passwordBusy ? 'Saving…' : hasPassword ? 'Update password' : 'Set password'}
                </button>
              </form>
              {passwordMsg && <p className={styles.passwordMsg}>{passwordMsg}</p>}
            </div>

            <div className={styles.accountActions}>
              <button
                className={styles.linkBtn}
                type="button"
                disabled={linkBusyProvider !== null}
                onClick={() => startLinkFlow('google')}
                data-testid="account-link-google"
              >
                {linkBusyProvider === 'google' ? 'Opening Google…' : 'Link Google'}
              </button>
              <button
                className={styles.linkBtn}
                type="button"
                disabled={linkBusyProvider !== null}
                onClick={() => startLinkFlow('github')}
                data-testid="account-link-github"
              >
                {linkBusyProvider === 'github' ? 'Opening GitHub…' : 'Link GitHub'}
              </button>
              <button
                className={styles.linkBtn}
                type="button"
                disabled={linkBusyProvider !== null}
                onClick={() => startLinkFlow('course')}
                data-testid="account-link-course"
              >
                {linkBusyProvider === 'course' ? 'Opening Course OAuth…' : 'Link Course OAuth'}
              </button>
            </div>

            {accountError && <p className={styles.err} role="alert" data-testid="account-error">{accountError}</p>}

            <button
              type="button"
              className={styles.logoutBtn}
              onClick={async () => {
                await logout();
                setShowAccount(false);
              }}
              data-testid="account-logout"
            >
              Log out
            </button>
          </div>
        </Modal>
      )}
    </nav>
  );
}

function communityHasUnreadChannels(community) {
  if (!community) return false;
  const unreadCount = Number(community.unread_channel_count ?? community.unreadChannelCount ?? 0);
  return Boolean(community.has_unread_channels ?? community.hasUnreadChannels ?? unreadCount > 0);
}

function CommunityIcon({ community, unread, active, onClick }) {
  const initials = community.name.slice(0, 2).toUpperCase();
  return (
    <button
      className={`${styles.icon} ${active ? styles.active : ''}`}
      title={community.name}
      onClick={onClick}
      aria-label={`Open community ${community.name}`}
      data-testid={`community-item-${community.id}`}
      data-community-id={community.id}
    >
      {community.icon_url
        ? <img src={community.icon_url} alt={community.name} className={styles.iconImg} />
        : <span className={styles.iconText}>{initials}</span>
      }
      {unread && (
        <span
          className={styles.communityUnreadDot}
          data-testid={`community-unread-indicator-${community.id}`}
          aria-label="Community has unread channels"
        />
      )}
    </button>
  );
}

function CreateCommunityModal({ onClose, onCreate }) {
  const [slug, setSlug]   = useState('');
  const [name, setName]   = useState('');
  const [desc, setDesc]   = useState('');
  const [err, setErr]     = useState('');
  const [busy, setBusy]   = useState(false);

  function normalizeSlug(value) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  }

  async function submit(e) {
    e.preventDefault();
    const normalizedSlug = normalizeSlug(slug || name);
    if (!normalizedSlug) {
      setErr('Slug must contain letters or numbers.');
      return;
    }

    setBusy(true); setErr('');
    try { await onCreate(normalizedSlug, name.trim(), desc.trim()); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="New Community" onClose={onClose}>
      {err && <p className={styles.err}>{err}</p>}
      <form onSubmit={submit} className={styles.form} data-testid="community-create-form">
        <label>Name
          <input value={name} onChange={e => { setName(e.target.value); setSlug(normalizeSlug(e.target.value)); }} required data-testid="community-create-name" />
        </label>
        <label>Slug (URL-safe)
          <input
            value={slug}
            onChange={e => setSlug(normalizeSlug(e.target.value))}
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            data-testid="community-create-slug"
          />
        </label>
        <label>Description
          <input value={desc} onChange={e => setDesc(e.target.value)} data-testid="community-create-description" />
        </label>
        <button type="submit" disabled={busy} data-testid="community-create-submit">{busy ? 'Creating…' : 'Create'}</button>
      </form>
    </Modal>
  );
}

function JoinCommunityModal({ onClose, onJoined }: { onClose: () => void; onJoined: (community: any) => Promise<void> }) {
  const [allCommunities, setAllCommunities] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/communities')
      .then(data => {
        const browseable = (data?.communities ?? []).filter((c: any) => !c.my_role);
        setAllCommunities(browseable);
      })
      .catch(e => setErr(e?.message || 'Could not load communities'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = query.trim()
    ? allCommunities.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.slug.toLowerCase().includes(query.toLowerCase())
      )
    : allCommunities;

  async function join(community: any) {
    setErr('');
    setBusyId(community.id);
    try {
      await api.post(`/communities/${community.id}/join`, {});
      await onJoined(community);
    } catch (e: any) {
      setErr(e?.message || 'Could not join community');
      setBusyId(null);
    }
  }

  return (
    <Modal title="Browse Communities" onClose={onClose}>
      <div className={styles.joinWrap}>
        <input
          className={styles.joinSearch}
          placeholder="Search communities…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
          data-testid="community-join-search"
        />
        {err && <p className={styles.err} role="alert">{err}</p>}
        {loading ? (
          <p className={styles.accountMuted}>Loading…</p>
        ) : filtered.length === 0 ? (
          <p className={styles.joinEmpty}>
            {allCommunities.length === 0 ? 'No public communities available.' : 'No communities match your search.'}
          </p>
        ) : (
          <ul className={styles.joinList} data-testid="community-join-list">
            {filtered.map(c => (
              <li key={c.id} className={styles.joinItem} data-testid={`community-join-item-${c.id}`}>
                <div className={styles.joinItemInfo}>
                  <span className={styles.joinItemName}>{c.name}</span>
                  {c.description && <span className={styles.joinItemDesc}>{c.description}</span>}
                  <span className={styles.joinItemMeta}>{c.member_count ?? 0} members</span>
                </div>
                <button
                  className={styles.joinBtn}
                  disabled={busyId !== null}
                  onClick={() => join(c)}
                  data-testid={`community-join-btn-${c.id}`}
                >
                  {busyId === c.id ? 'Joining…' : 'Join'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function buildAvatarSrc(user?: any) {
  const base = user?.avatarUrl || user?.avatar_url;
  if (!base) return '';
  const version = user?.updatedAt || user?.updated_at || '';
  if (!version) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}v=${encodeURIComponent(version)}`;
}

export function Avatar({ name = '?', size = 32, user }: { name?: string; size?: number; user?: any }) {
  const initials = name.slice(0, 2).toUpperCase();
  const src = buildAvatarSrc(user);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [src]);

  // Deterministic hue from name
  let hash = 0;
  for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;

  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `hsl(${hue}, 45%, 30%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.35, fontWeight: 600, color: `hsl(${hue}, 70%, 80%)`,
      overflow: 'hidden',
      flexShrink: 0,
      border: '1px solid rgba(255,255,255,0.07)',
    }}>
      {src && !imgError ? (
        <img
          src={src}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgError(true)}
        />
      ) : initials}
    </div>
  );
}
