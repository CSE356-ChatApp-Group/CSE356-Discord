import styles from '../ChannelSidebar.module.css';

export function ChannelRow({ channel, active, unreadCount, canAccess, canDelete, onDelete, onClick }: { channel: any, active: boolean, unreadCount: number, canAccess: boolean, canDelete: boolean, onDelete?: () => void, onClick: () => void }) {
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

export function DmRow({ conv, currentUserId, unreadCount, active, onClick }: { conv: any, currentUserId?: string, unreadCount: number, active: boolean, onClick: () => void }) {
  const others = (conv.participants || []).filter((p: { id: string }) => p.id !== currentUserId);
  const name   = conv.name || others.map((p: { displayName?: string; username?: string }) => p.displayName || p.username).join(', ') || 'Group DM';
  return (
    <button className={`${styles.row} ${active ? styles.rowActive : ''}`} onClick={onClick} data-testid={`dm-item-${conv.id}`} data-conversation-id={conv.id} data-read-state={unreadCount > 0 ? 'UNREAD' : 'READ'} aria-label={`Open direct conversation ${name}`}>
      <span className={styles.dmIcon}>@</span>
      <span className={styles.rowName}>{name}</span>
      {unreadCount > 0 && (
        <span
          className={styles.unreadBadge}
          data-testid={`dm-unread-indicator-${conv.id}`}
          data-read-state="UNREAD"
          aria-label={`${unreadCount} unread messages`}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  );
}
