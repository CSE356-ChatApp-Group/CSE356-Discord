import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { api } from '../lib/api';
import Modal from './Modal';
import styles from './CommunitySidebar.module.css';

export default function CommunitySidebar() {
  const { communities, activeCommunity, selectCommunity, createCommunity } = useChatStore();
  const logout = useAuthStore(s => s.logout);
  const user   = useAuthStore(s => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [linkedProviders, setLinkedProviders] = useState<string[]>([]);
  const [hasPassword, setHasPassword] = useState(false);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linkBusyProvider, setLinkBusyProvider] = useState<string | null>(null);
  const [accountError, setAccountError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ newPassword: '', confirmPassword: '' });
  const [passwordMsg, setPasswordMsg] = useState('');

  async function openAccountModal() {
    setShowAccount(true);
    setAccountError('');
    setLoadingLinks(true);
    try {
      const data = await api.get('/auth/oauth/linked');
      setLinkedProviders(Array.isArray(data?.providers) ? data.providers : []);
      setHasPassword(Boolean(data?.hasPassword));
    } catch (e) {
      setAccountError(e?.message || 'Could not load linked providers');
      setLinkedProviders([]);
      setHasPassword(false);
    } finally {
      setLoadingLinks(false);
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

  return (
    <nav className={styles.sidebar}>
      {/* Community icons */}
      <div className={styles.list}>
        {communities.map(c => (
          <CommunityIcon
            key={c.id}
            community={c}
            active={activeCommunity?.id === c.id}
            onClick={() => selectCommunity(c)}
          />
        ))}

        <button
          className={styles.addBtn}
          title="Create community"
          onClick={() => setShowCreate(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      {/* User avatar at bottom */}
      <div className={styles.bottom}>
        <button className={styles.userBtn} title={`${user?.username} – account settings`} onClick={openAccountModal}>
          <Avatar name={user?.displayName || user?.username} size={36} />
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

      {showAccount && (
        <Modal title="Account" onClose={() => setShowAccount(false)}>
          <div className={styles.accountWrap}>
            <div className={styles.accountIdentity}>
              <Avatar name={user?.displayName || user?.username} size={44} />
              <div>
                <p className={styles.accountName}>{user?.displayName || user?.username}</p>
                <p className={styles.accountEmail}>{user?.email || 'No email available'}</p>
              </div>
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
              <form className={styles.passwordForm} onSubmit={submitPassword}>
                <input
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  placeholder="New password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <input
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <button type="submit" className={styles.passwordBtn} disabled={passwordBusy}>
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
              >
                {linkBusyProvider === 'google' ? 'Opening Google…' : 'Link Google'}
              </button>
              <button
                className={styles.linkBtn}
                type="button"
                disabled={linkBusyProvider !== null}
                onClick={() => startLinkFlow('github')}
              >
                {linkBusyProvider === 'github' ? 'Opening GitHub…' : 'Link GitHub'}
              </button>
              <button
                className={styles.linkBtn}
                type="button"
                disabled={linkBusyProvider !== null}
                onClick={() => startLinkFlow('course')}
              >
                {linkBusyProvider === 'course' ? 'Opening Course OAuth…' : 'Link Course OAuth'}
              </button>
            </div>

            {accountError && <p className={styles.err}>{accountError}</p>}

            <button
              type="button"
              className={styles.logoutBtn}
              onClick={async () => {
                await logout();
                setShowAccount(false);
              }}
            >
              Log out
            </button>
          </div>
        </Modal>
      )}
    </nav>
  );
}

function CommunityIcon({ community, active, onClick }) {
  const initials = community.name.slice(0, 2).toUpperCase();
  return (
    <button
      className={`${styles.icon} ${active ? styles.active : ''}`}
      title={community.name}
      onClick={onClick}
    >
      {community.icon_url
        ? <img src={community.icon_url} alt={community.name} className={styles.iconImg} />
        : <span className={styles.iconText}>{initials}</span>
      }
      {active && <span className={styles.activePip} />}
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
      <form onSubmit={submit} className={styles.form}>
        <label>Name
          <input value={name} onChange={e => { setName(e.target.value); setSlug(normalizeSlug(e.target.value)); }} required />
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
          />
        </label>
        <label>Description
          <input value={desc} onChange={e => setDesc(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
      </form>
    </Modal>
  );
}

export function Avatar({ name = '?', size = 32 }) {
  const initials = name.slice(0, 2).toUpperCase();
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
      flexShrink: 0,
      border: '1px solid rgba(255,255,255,0.07)',
    }}>
      {initials}
    </div>
  );
}
