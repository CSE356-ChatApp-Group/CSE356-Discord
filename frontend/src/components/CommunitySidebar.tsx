import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import Modal from './Modal';
import styles from './CommunitySidebar.module.css';

export default function CommunitySidebar() {
  const { communities, activeCommunity, selectCommunity, createCommunity } = useChatStore();
  const logout = useAuthStore(s => s.logout);
  const user   = useAuthStore(s => s.user);
  const [showCreate, setShowCreate] = useState(false);

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
        <button className={styles.userBtn} title={`${user?.username} – click to log out`} onClick={logout}>
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
