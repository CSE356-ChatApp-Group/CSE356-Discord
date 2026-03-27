import { useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { Avatar } from './CommunitySidebar';
import styles from './MemberList.module.css';

const STATUS_LABEL = { online: 'Online', idle: 'Idle', away: 'Away', offline: 'Offline' };

export default function MemberList() {
  const { members, presence } = useChatStore();
  const currentUser = useAuthStore(s => s.user);

  // Group by status
  const groups = { online: [], idle: [], away: [], offline: [] };
  for (const m of members) {
    const s = presence[m.id] || 'offline';
    groups[s].push({ ...m, status: s });
  }

  return (
    <aside className={`${styles.list} memberList`} aria-label="Community members" data-testid="member-list">
      <div className={styles.header} data-testid="member-list-header">Members <span className={styles.count}>{members.length}</span></div>
      <div className={styles.scroll} data-testid="member-list-scroll">
        {['online', 'idle', 'away', 'offline'].map(status => {
          const grp = groups[status];
          if (!grp.length) return null;
          return (
            <div key={status}>
              <div className={styles.groupLabel}>
                {STATUS_LABEL[status]} — {grp.length}
              </div>
              {grp.map(m => (
                <MemberRow
                  key={m.id}
                  member={m}
                  isYou={m.id === currentUser?.id}
                />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function MemberRow({ member, isYou }) {
  const name = member.displayName || member.display_name || member.username;
  return (
    <div className={styles.row} title={`${name}${isYou ? ' (you)' : ''} · ${member.role}`} data-testid={`member-row-${member.id}`} data-member-id={member.id} data-member-status={member.status}>
      <div className={styles.avatarWrap}>
        <Avatar name={name} size={30} />
        <span className={`${styles.dot} ${styles[member.status]}`} />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>
          {name}
          {isYou && <span className={styles.you}>you</span>}
        </span>
        {member.role !== 'member' && (
          <span className={styles.role}>{member.role}</span>
        )}
      </div>
    </div>
  );
}
