import { useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import Modal from './Modal';
import styles from './ChannelSidebar.module.css';

export default function ChannelSidebar() {
  const {
    activeCommunity, channels, activeChannel,
    conversations, activeConv,
    selectChannel, selectConversation, createChannel,
  } = useChatStore();
  const user = useAuthStore(s => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  if (!activeCommunity && conversations.length === 0) {
    return (
      <aside className={styles.sidebar} aria-label="Channels and DMs" data-testid="channel-sidebar-empty">
        <div className={styles.empty}>
          <p>No direct messages yet</p>
        </div>
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
                onClick={() => selectChannel(ch)}
              />
            ))}
          </>
        ) : (
          <>
            <div className={styles.sectionHeader}>
              <span>Messages</span>
            </div>
            {conversations.length === 0 && (
              <p className={styles.hint}>No DMs yet</p>
            )}
            {conversations.map(conv => (
              <DmRow
                key={conv.id}
                conv={conv}
                currentUserId={user?.id}
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
    </aside>
  );
}

function ChannelRow({ channel, active, onClick }) {
  return (
    <button className={`${styles.row} ${active ? styles.rowActive : ''}`} onClick={onClick} data-testid={`channel-item-${channel.id}`} data-channel-id={channel.id} aria-label={`Open channel ${channel.name}`}>
      <span className={styles.hash}>{channel.is_private ? '🔒' : '#'}</span>
      <span className={styles.rowName}>{channel.name}</span>
    </button>
  );
}

function DmRow({ conv, currentUserId, active, onClick }) {
  const others = (conv.participants || []).filter(p => p.id !== currentUserId);
  const name   = conv.name || others.map(p => p.displayName || p.username).join(', ') || 'Unknown';
  return (
    <button className={`${styles.row} ${active ? styles.rowActive : ''}`} onClick={onClick} data-testid={`dm-item-${conv.id}`} data-conversation-id={conv.id} aria-label={`Open direct conversation ${name}`}>
      <span className={styles.dmIcon}>@</span>
      <span className={styles.rowName}>{name}</span>
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
