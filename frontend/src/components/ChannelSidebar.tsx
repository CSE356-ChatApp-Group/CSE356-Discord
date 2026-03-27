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
  const [section, setSection] = useState('channels'); // 'channels' | 'dms'

  if (!activeCommunity && conversations.length === 0) {
    return (
      <aside className={styles.sidebar} aria-label="Channels and DMs" data-testid="channel-sidebar-empty">
        <div className={styles.empty}>
          <p>Select or create<br/>a community</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.sidebar} aria-label="Channels and DMs" data-testid="channel-sidebar">
      {activeCommunity && (
        <div className={styles.header} data-testid="channel-sidebar-header">
          <span className={styles.communityName}>{activeCommunity.name}</span>
        </div>
      )}

      {/* Section tabs */}
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${section === 'channels' ? styles.tabActive : ''}`} onClick={() => setSection('channels')} data-testid="tab-channels" aria-label="Show channels">
          Channels
        </button>
        <button className={`${styles.tab} ${section === 'dms' ? styles.tabActive : ''}`} onClick={() => setSection('dms')} data-testid="tab-dms" aria-label="Show direct messages">
          DMs
        </button>
      </div>

      <div className={styles.scroll} data-testid="channel-sidebar-scroll">
        {section === 'channels' && (
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
        )}

        {section === 'dms' && (
          <>
            <div className={styles.sectionHeader}><span>Direct Messages</span></div>
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
