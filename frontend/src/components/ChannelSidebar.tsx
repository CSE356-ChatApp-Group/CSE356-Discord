import { useState, useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { api } from '../lib/api';
import Modal from './Modal';
import styles from './ChannelSidebar.module.css';

export default function ChannelSidebar() {
  const {
    activeCommunity, channels, activeChannel,
    conversations, activeConv,
    selectChannel, selectConversation, createChannel, openDm,
  } = useChatStore();
  const user = useAuthStore(s => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);

  if (!activeCommunity && conversations.length === 0) {
    return (
      <aside className={styles.sidebar} aria-label="Channels and DMs" data-testid="channel-sidebar-empty">
        <div className={styles.scroll}>
          <div className={styles.sectionHeader}>
            <span>Messages</span>
            <button
              className={styles.sectionAdd}
              title="New direct message"
              aria-label="Start new direct message"
              data-testid="dm-create-open"
              onClick={() => setShowNewDm(true)}
            >+</button>
          </div>
          <div className={styles.empty}>
            <p>No direct messages yet</p>
          </div>
        </div>
        {showNewDm && (
          <NewDmModal
            currentUserId={user?.id}
            onClose={() => setShowNewDm(false)}
            onOpen={async (userId) => {
              setShowNewDm(false);
              await openDm(userId);
            }}
          />
        )}
      </aside>
    );
  }

  return (
    <aside className={styles.sidebar} aria-label="Channels and DMs" data-testid="channel-sidebar">
      {activeCommunity && (
        <div className={styles.header} data-testid="channel-sidebar-header">
          <span className={styles.communityName}>{activeCommunity.name}</span>
          <div className={styles.headerActions}>
            <button
              className={styles.inviteBtn}
              title="Invite people"
              aria-label="Invite people to server"
              data-testid="community-invite-open"
              onClick={() => setShowInvite(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="8.5" cy="7" r="4"/>
                <line x1="20" y1="8" x2="20" y2="14"/>
                <line x1="23" y1="11" x2="17" y2="11"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className={styles.scroll} data-testid="channel-sidebar-scroll">
        {activeCommunity ? (
          <>
            <div className={styles.sectionHeader}>
              <span>Channels</span>
              {activeCommunity && (
                <button className={styles.sectionAdd} title="New channel" onClick={() => setShowCreate(true)} aria-label="Create channel" data-testid="channel-create-open">+</button>
              )}
            </div>
            {channels.length === 0 && (
              <p className={styles.hint}>No channels yet</p>
            )}
            {channels.map(ch => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                active={activeChannel?.id === ch.id}
                unread={isChannelUnread(ch, activeChannel?.id === ch.id, user?.id)}
                onClick={() => selectChannel(ch)}
              />
            ))}
          </>
        ) : (
          <>
            <div className={styles.sectionHeader}>
              <span>Messages</span>
              <button
                className={styles.sectionAdd}
                title="New direct message"
                aria-label="Start new direct message"
                data-testid="dm-create-open"
                onClick={() => setShowNewDm(true)}
              >+</button>
            </div>
            {conversations.length === 0 && (
              <p className={styles.hint}>No DMs yet</p>
            )}
            {conversations.map(conv => (
              <DmRow
                key={conv.id}
                conv={conv}
                currentUserId={user?.id}
                unread={isConversationUnread(conv, activeConv?.id === conv.id, user?.id)}
                active={activeConv?.id === conv.id}
                onClick={() => selectConversation(conv)}
              />
            ))}
          </>
        )}
      </div>

      {showCreate && (
        <CreateChannelModal
          onClose={() => setShowCreate(false)}
          onCreate={async (name, isPrivate) => {
            await createChannel(activeCommunity.id, name, isPrivate);
            setShowCreate(false);
          }}
        />
      )}

      {showInvite && activeCommunity && (
        <InviteCommunityModal
          community={activeCommunity}
          onClose={() => setShowInvite(false)}
        />
      )}

      {showNewDm && (
        <NewDmModal
          currentUserId={user?.id}
          onClose={() => setShowNewDm(false)}
          onOpen={async (userId) => {
            setShowNewDm(false);
            await openDm(userId);
          }}
        />
      )}
    </aside>
  );
}

function ChannelRow({ channel, active, unread, onClick }) {
  return (
    <button className={`${styles.row} ${active ? styles.rowActive : ''}`} onClick={onClick} data-testid={`channel-item-${channel.id}`} data-channel-id={channel.id} data-read-state={unread ? 'UNREAD' : 'READ'} aria-label={`Open channel ${channel.name}`}>
      <span className={styles.hash}>{channel.is_private ? '🔒' : '#'}</span>
      <span className={styles.rowName}>{channel.name}</span>
      {unread && (
        <span
          className={styles.unreadDot}
          data-testid={`channel-unread-indicator-${channel.id}`}
          data-read-state="UNREAD"
          aria-label="Unread channel"
        />
      )}
    </button>
  );
}

function isChannelUnread(channel, active, currentUserId) {
  if (active) return false;
  const hasActivity = Boolean(channel?.has_new_activity ?? channel?.hasNewActivity);
  if (hasActivity) return true;
  const lastMessageAuthorId = channel?.last_message_author_id || channel?.lastMessageAuthorId;
  const lastMessageId = channel?.last_message_id || channel?.lastMessageId;
  const myLastReadMessageId = channel?.my_last_read_message_id || channel?.myLastReadMessageId;
  if (!lastMessageId) return false;
  if (lastMessageAuthorId === currentUserId) return false;
  return myLastReadMessageId !== lastMessageId;
}

function isConversationUnread(conv, active, currentUserId) {
  if (active) return false;
  const lastMessageAuthorId = conv?.last_message_author_id || conv?.lastMessageAuthorId;
  const lastMessageId = conv?.last_message_id || conv?.lastMessageId;
  const myLastReadMessageId = conv?.my_last_read_message_id || conv?.myLastReadMessageId;
  if (!lastMessageId) return false;
  if (lastMessageAuthorId === currentUserId) return false;
  return myLastReadMessageId !== lastMessageId;
}

function DmRow({ conv, currentUserId, unread, active, onClick }) {
  const others = (conv.participants || []).filter(p => p.id !== currentUserId);
  const name   = conv.name || others.map(p => p.displayName || p.username).join(', ') || 'Unknown';
  return (
    <button className={`${styles.row} ${active ? styles.rowActive : ''}`} onClick={onClick} data-testid={`dm-item-${conv.id}`} data-conversation-id={conv.id} data-read-state={unread ? 'UNREAD' : 'READ'} aria-label={`Open direct conversation ${name}`}>
      <span className={styles.dmIcon}>@</span>
      <span className={styles.rowName}>{name}</span>
      {unread && (
        <span
          className={styles.unreadDot}
          data-testid={`dm-unread-indicator-${conv.id}`}
          data-read-state="UNREAD"
          aria-label="Unread conversation"
        />
      )}
    </button>
  );
}

function InviteCommunityModal({ community, onClose }) {
  const [copied, setCopied] = useState(false);
  const inviteCode = community?.invite_code || community?.inviteCode || '';
  const inviteUrl = inviteCode ? `${window.location.origin}/invite/${inviteCode}` : '';

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal title="Invite people" onClose={onClose}>
      <div className={styles.form} data-testid="community-invite-modal">
        <label>Invite link
          <input value={inviteUrl || 'Invite link unavailable'} readOnly data-testid="community-invite-link" />
        </label>
        <button type="button" onClick={handleCopy} disabled={!inviteUrl} data-testid="community-invite-copy">
          {copied ? 'Copied' : 'Copy invite link'}
        </button>
      </div>
    </Modal>
  );
}

function CreateChannelModal({ onClose, onCreate }) {
  const [name, setName]         = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [err, setErr]           = useState('');
  const [busy, setBusy]         = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await onCreate(name, isPrivate); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title="New Channel" onClose={onClose}>
      {err && <p className={styles.err}>{err}</p>}
      <form onSubmit={submit} className={styles.form} data-testid="channel-create-form">
        <label>Channel name
          <input value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} required placeholder="e.g. general" data-testid="channel-create-name" />
        </label>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={isPrivate} onChange={e => setPrivate(e.target.checked)} data-testid="channel-create-private" />
          Private channel
        </label>
        <button type="submit" disabled={busy} data-testid="channel-create-submit">{busy ? 'Creating…' : 'Create channel'}</button>
      </form>
    </Modal>
  );
}

function NewDmModal({ currentUserId, onClose, onOpen }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const inputRef              = useRef<HTMLInputElement>(null);
  const debounceRef           = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get(`/users?q=${encodeURIComponent(q.trim())}`);
        const users: any[] = data.users ?? data ?? [];
        setResults(users.filter((u: any) => u.id !== currentUserId));
      } catch {
        setResults([]);
      }
    }, 250);
  }, [currentUserId]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    search(e.target.value);
  }

  async function handleSelect(userId: string) {
    setBusy(true); setErr('');
    try { await onOpen(userId); }
    catch (e: any) { setErr(e?.message ?? 'Failed to open DM'); setBusy(false); }
  }

  return (
    <Modal title="New message" onClose={onClose}>
      <div className={styles.newDmModal} data-testid="dm-create-modal">
        <input
          ref={inputRef}
          className={styles.newDmSearch}
          type="text"
          placeholder="Find a user by name or username…"
          value={query}
          onChange={handleChange}
          data-testid="dm-search-input"
        />
        {err && <p className={styles.err}>{err}</p>}
        {results.length > 0 && (
          <ul className={styles.newDmResults} data-testid="dm-search-results">
            {results.map(u => (
              <li key={u.id}>
                <button
                  className={styles.newDmResultBtn}
                  onClick={() => handleSelect(u.id)}
                  disabled={busy}
                  data-testid={`dm-user-result-${u.id}`}
                  data-user-id={u.id}
                >
                  <span className={styles.newDmResultName}>{u.displayName || u.display_name || u.username}</span>
                  {(u.username) && <span className={styles.newDmResultUsername}>@{u.username}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && results.length === 0 && (
          <p className={styles.hint}>No users found</p>
        )}
      </div>
    </Modal>
  );
}
