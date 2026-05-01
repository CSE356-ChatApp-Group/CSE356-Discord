import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import Modal from './Modal';
import styles from './ChannelSidebar.module.css';
import CreateChannelModal from './channelSidebar/CreateChannelModal';
import NewDmModal from './channelSidebar/NewDmModal';
import { ChannelRow, DmRow } from './channelSidebar/ChannelSidebarRows';
import {
  canManageChannels,
  canLeaveCommunity,
  isCommunityOwner,
  getChannelUnreadCount,
  getConversationUnreadCount,
} from './channelSidebar/channelSidebarHelpers';

export default function ChannelSidebar() {
  const {
    activeCommunity, channels, activeChannel,
    conversations, activeConv,
    selectChannel, selectConversation, createChannel, deleteChannel, deleteCommunity, leaveCommunity, openDm,
  } = useChatStore(
    useShallow((s) => ({
      activeCommunity: s.activeCommunity,
      channels: s.channels,
      activeChannel: s.activeChannel,
      conversations: s.conversations,
      activeConv: s.activeConv,
      selectChannel: s.selectChannel,
      selectConversation: s.selectConversation,
      createChannel: s.createChannel,
      deleteChannel: s.deleteChannel,
      deleteCommunity: s.deleteCommunity,
      leaveCommunity: s.leaveCommunity,
      openDm: s.openDm,
    })),
  );
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
                unreadCount={getChannelUnreadCount(ch, activeChannel?.id === ch.id, user?.id)}
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
                unreadCount={getConversationUnreadCount(conv, activeConv?.id === conv.id, user?.id)}
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
