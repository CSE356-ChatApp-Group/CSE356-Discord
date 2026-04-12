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
    selectChannel, selectConversation, createChannel, deleteChannel, deleteCommunity, leaveCommunity, openDm,
  } = useChatStore();
  const user = useAuthStore(s => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [showDeleteCommunityConfirm, setShowDeleteCommunityConfirm] = useState(false);
  const [deleteCommunityBusy, setDeleteCommunityBusy] = useState(false);
  const [channelToDelete, setChannelToDelete] = useState<any | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const canManage = canManageChannels(activeCommunity);
  const canLeave = canLeaveCommunity(activeCommunity);
  const canDeleteCommunity = isCommunityOwner(activeCommunity);

  function handleLeaveCommunity() {
    if (!activeCommunity?.id || !canLeave) return;
    setShowLeaveConfirm(true);
  }

  async function confirmLeaveCommunity() {
    if (!activeCommunity?.id || leaveBusy) return;
    setLeaveBusy(true);
    try {
      await leaveCommunity(activeCommunity.id);
      setShowLeaveConfirm(false);
    } finally {
      setLeaveBusy(false);
    }
  }

  async function confirmDeleteCommunity() {
    if (!activeCommunity?.id || deleteCommunityBusy || !canDeleteCommunity) return;
    setDeleteCommunityBusy(true);
    try {
      await deleteCommunity(activeCommunity.id);
      setShowDeleteCommunityConfirm(false);
    } finally {
      setDeleteCommunityBusy(false);
    }
  }

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
            onOpen={async (participantIds) => {
              setShowNewDm(false);
              await openDm(participantIds);
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
            {canDeleteCommunity ? (
              <button
                className={styles.inviteBtn}
                title="Delete community"
                aria-label="Delete community"
                data-testid="community-delete-btn"
                onClick={() => setShowDeleteCommunityConfirm(true)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14H6L5 6"/>
                  <path d="M10 11v6"/>
                  <path d="M14 11v6"/>
                  <path d="M9 6V4h6v2"/>
                </svg>
              </button>
            ) : (
              <button
                className={styles.inviteBtn}
                title={canLeave ? 'Leave community' : 'Owners cannot leave community'}
                aria-label="Leave community"
                data-testid="community-leave-btn"
                onClick={handleLeaveCommunity}
                disabled={!canLeave}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      <div className={styles.scroll} data-testid="channel-sidebar-scroll">
        {activeCommunity ? (
          <>
            <div className={styles.sectionHeader}>
              <span>Channels</span>
              {activeCommunity && canManage && (
                <button className={styles.sectionAdd} title="New channel" onClick={() => setShowCreate(true)} aria-label="Create channel" data-testid="channel-create-open">+</button>
              )}
            </div>
            {channels.length === 0 && (
              <p className={styles.hint}>No channels yet</p>
            )}
            {channels.map((ch) => {
              const canAccess = ch.can_access ?? ch.canAccess ?? !ch.is_private;
              return (
              <ChannelRow
                key={ch.id}
                channel={ch}
                active={activeChannel?.id === ch.id}
                canAccess={canAccess}
                unreadCount={getChannelUnreadCount(ch, activeChannel?.id === ch.id)}
                canDelete={canManage}
                onDelete={() => setChannelToDelete(ch)}
                onClick={() => {
                  if (!canAccess) return;
                  void selectChannel(ch);
                }}
              />
              );
            })}
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

      {showNewDm && (
        <NewDmModal
          currentUserId={user?.id}
          onClose={() => setShowNewDm(false)}
          onOpen={async (participantIds) => {
            setShowNewDm(false);
            await openDm(participantIds);
          }}
        />
      )}

      {showLeaveConfirm && activeCommunity && (
        <Modal title="Leave community?" onClose={() => setShowLeaveConfirm(false)}>
          <div className={styles.leaveConfirmWrap} data-testid="community-leave-modal">
            <p className={styles.hint}>
              You will leave {activeCommunity.name}. You can rejoin later if the community is public.
            </p>
            <div className={styles.leaveConfirmActions}>
              <button
                type="button"
                className={styles.leaveCancelBtn}
                onClick={() => setShowLeaveConfirm(false)}
                disabled={leaveBusy}
                data-testid="community-leave-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.leaveDangerBtn}
                onClick={() => { void confirmLeaveCommunity(); }}
                disabled={leaveBusy}
                data-testid="community-leave-confirm"
              >
                {leaveBusy ? 'Leaving…' : 'Leave community'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showDeleteCommunityConfirm && activeCommunity && (
        <Modal title="Delete community?" onClose={() => setShowDeleteCommunityConfirm(false)}>
          <div className={styles.leaveConfirmWrap} data-testid="community-delete-modal">
            <p className={styles.hint}>
              Delete {activeCommunity.name}? All channels and messages in this community will be permanently removed.
            </p>
            <div className={styles.leaveConfirmActions}>
              <button
                type="button"
                className={styles.leaveCancelBtn}
                onClick={() => setShowDeleteCommunityConfirm(false)}
                disabled={deleteCommunityBusy}
                data-testid="community-delete-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.leaveDangerBtn}
                onClick={() => { void confirmDeleteCommunity(); }}
                disabled={deleteCommunityBusy}
                data-testid="community-delete-confirm"
              >
                {deleteCommunityBusy ? 'Deleting…' : 'Delete community'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {channelToDelete && (
        <Modal title="Delete channel?" onClose={() => setChannelToDelete(null)}>
          <div className={styles.leaveConfirmWrap} data-testid="channel-delete-modal">
            <p className={styles.hint}>
              Delete #{channelToDelete.name}? This action cannot be undone.
            </p>
            <div className={styles.leaveConfirmActions}>
              <button
                type="button"
                className={styles.leaveCancelBtn}
                onClick={() => setChannelToDelete(null)}
                disabled={deleteBusy}
                data-testid="channel-delete-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.leaveDangerBtn}
                onClick={async () => {
                  if (!channelToDelete?.id || deleteBusy) return;
                  setDeleteBusy(true);
                  try {
                    await deleteChannel(channelToDelete.id);
                    setChannelToDelete(null);
                  } finally {
                    setDeleteBusy(false);
                  }
                }}
                disabled={deleteBusy}
                data-testid="channel-delete-confirm"
              >
                {deleteBusy ? 'Deleting…' : 'Delete channel'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </aside>
  );
}

function ChannelRow({ channel, active, unreadCount, canAccess, canDelete, onDelete, onClick }: { channel: any, active: boolean, unreadCount: number, canAccess: boolean, canDelete: boolean, onDelete?: () => void, onClick: () => void }) {
  return (
    <button
      className={`${styles.row} ${active ? styles.rowActive : ''} ${canAccess ? '' : styles.rowDisabled}`}
      onClick={onClick}
      data-testid={`channel-item-${channel.id}`}
      data-channel-id={channel.id}
      data-read-state={unreadCount > 0 ? 'UNREAD' : 'READ'}
      aria-label={canAccess ? `Open channel ${channel.name}` : `Private channel ${channel.name} requires invite`}
      title={canAccess ? `Open channel ${channel.name}` : 'Invite required to read channel contents'}
    >
      <span className={styles.hash}>{channel.is_private ? '🔒' : '#'}</span>
      <span className={styles.rowName}>{channel.name}</span>
      {canDelete && (
        <span
          className={styles.rowAction}
          role="button"
          tabIndex={0}
          title={`Delete #${channel.name}`}
          aria-label={`Delete channel ${channel.name}`}
          data-testid={`channel-delete-${channel.id}`}
          onClick={(e) => {
            e.stopPropagation();
            void onDelete?.();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              void onDelete?.();
            }
          }}
        >
          ×
        </span>
      )}
      {unreadCount > 0 && (
        <span
          className={styles.unreadBadge}
          data-testid={`channel-unread-indicator-${channel.id}`}
          data-read-state="UNREAD"
          aria-label={`${unreadCount} unread messages`}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}

function canManageChannels(community) {
  const role = community?.my_role || community?.myRole;
  return role === 'owner' || role === 'admin';
}

function canLeaveCommunity(community) {
  if (!community) return false;
  const role = community?.my_role || community?.myRole;
  return role && role !== 'owner';
}

function isCommunityOwner(community) {
  if (!community) return false;
  const role = community?.my_role || community?.myRole;
  return role === 'owner';
}

function getChannelUnreadCount(channel, active): number {
  if (active) return 0;
  const canAccess = channel?.can_access ?? channel?.canAccess ?? !channel?.is_private;
  if (!canAccess) return 0;
  const count = channel?.unread_message_count ?? 0;
  // Fall back to at-least-1 if has_new_activity is set but count hasn't propagated yet
  if (count === 0 && Boolean(channel?.has_new_activity ?? channel?.hasNewActivity)) return 1;
  return count;
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

function DmRow({ conv, currentUserId, unread, active, onClick }: { conv: any, currentUserId?: string, unread: boolean, active: boolean, onClick: () => void }) {
  const others = (conv.participants || []).filter(p => p.id !== currentUserId);
  const name   = conv.name || others.map(p => p.displayName || p.username).join(', ') || 'Group DM';
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
      {err && <p className={styles.err} role="alert">{err}</p>}
      <form onSubmit={submit} className={styles.form} data-testid="channel-create-form">
        <label>Name
          <input value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} required placeholder="e.g. general" data-testid="channel-create-name" />
        </label>
        <div className={styles.formToggle}>
          <label className={styles.checkLabel}>
            <input type="checkbox" checked={isPrivate} onChange={e => setPrivate(e.target.checked)} data-testid="channel-create-private" />
            Private channel
          </label>
        </div>
        <button type="submit" disabled={busy} data-testid="channel-create-submit">{busy ? 'Creating…' : 'Create channel'}</button>
      </form>
    </Modal>
  );
}

function NewDmModal({ currentUserId, onClose, onOpen }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<any[]>([]);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const inputRef              = useRef<HTMLInputElement>(null);
  const debounceRef           = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

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

  function toggleSelect(user) {
    if (!user?.id) return;
    setSelectedUsers((prev) => {
      const exists = prev.some((entry) => entry.id === user.id);
      if (exists) return prev.filter((entry) => entry.id !== user.id);
      return [...prev, user];
    });
  }

  async function handleCreateConversation(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUsers.length) {
      setErr('Select at least one user.');
      return;
    }

    setBusy(true); setErr('');
    try { await onOpen(selectedUsers.map((user) => user.id)); }
    catch (e: any) { setErr(e?.message ?? 'Failed to open DM'); setBusy(false); }
  }

  return (
    <Modal title="New message" onClose={onClose}>
      <form className={styles.newDmModal} data-testid="dm-create-modal" onSubmit={handleCreateConversation}>
        <input
          ref={inputRef}
          className={styles.newDmSearch}
          type="text"
          placeholder="Find people by name or username…"
          value={query}
          onChange={handleChange}
          data-testid="dm-search-input"
        />
        {err && <p className={styles.err}>{err}</p>}
        {selectedUsers.length > 0 && (
          <div className={styles.selectedUsers} data-testid="dm-selected-users">
            {selectedUsers.map((user) => (
              <button
                key={user.id}
                type="button"
                className={styles.selectedUserChip}
                onClick={() => toggleSelect(user)}
                data-testid={`dm-selected-user-${user.id}`}
              >
                <span>{user.displayName || user.display_name || user.username}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}
        {results.length > 0 && (
          <ul className={styles.newDmResults} data-testid="dm-search-results">
            {results.map(u => (
              <li key={u.id}>
                <button
                  type="button"
                  className={styles.newDmResultBtn}
                  onClick={() => toggleSelect(u)}
                  disabled={busy}
                  data-testid={`dm-user-result-${u.id}`}
                  data-user-id={u.id}
                >
                  <span className={styles.newDmResultName}>{u.displayName || u.display_name || u.username}</span>
                  {(u.username) && <span className={styles.newDmResultUsername}>@{u.username}</span>}
                  {selectedUsers.some((entry) => entry.id === u.id) && <span className={styles.newDmSelectedMark}>Selected</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && results.length === 0 && (
          <p className={styles.hint}>No users found</p>
        )}
        <div className={styles.newDmActions}>
          <button type="button" className={styles.newDmCancelBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={styles.newDmCreateBtn} disabled={busy || selectedUsers.length === 0} data-testid="dm-create-submit">
            {busy ? 'Starting…' : selectedUsers.length > 1 ? 'Create group DM' : 'Start DM'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
