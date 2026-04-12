import { memo, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PRESENCE_STATUSES, useChatStore } from '../stores/chatStore';
import { useAuthStore  } from '../stores/authStore';
import { Avatar } from './CommunitySidebar';
import styles from './MemberList.module.css';

const STATUS_LABEL: Record<(typeof PRESENCE_STATUSES)[number], string> = {
  online: 'Online',
  idle: 'Idle',
  away: 'Away',
  offline: 'Offline',
};

export default function MemberList() {
  const {
    members,
    activeConv,
    activeCommunity,
    presence,
    awayMessages,
    hydratePresenceForUsers,
    updateCommunityMemberRole,
  } = useChatStore(
    useShallow((s) => ({
      members: s.members,
      activeConv: s.activeConv,
      activeCommunity: s.activeCommunity,
      presence: s.presence,
      awayMessages: s.awayMessages,
      hydratePresenceForUsers: s.hydratePresenceForUsers,
      updateCommunityMemberRole: s.updateCommunityMemberRole,
    })),
  );
  const currentUser = useAuthStore(s => s.user);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const isDm = !!activeConv;
  const list: Record<string, any>[] = isDm ? (activeConv.participants ?? []) : members;
  const label = isDm ? 'Participants' : 'Members';
  const canManageRoles = !isDm && (activeCommunity?.my_role || activeCommunity?.myRole) === 'owner';

  useEffect(() => {
    const ids: string[] = Array.from(
      new Set((list || []).map((m) => (m?.id ? String(m.id) : '')).filter(Boolean))
    );
    if (!ids.length) return;

    hydratePresenceForUsers(ids).catch(() => {});
  }, [list, hydratePresenceForUsers]);

  const groups = useMemo(() => {
    const g = { online: [], idle: [], away: [], offline: [] };
    for (const m of list) {
      const candidate = presence[m.id] || m.status || 'offline';
      const s = PRESENCE_STATUSES.includes(candidate) ? candidate : 'offline';
      g[s].push({ ...m, status: s, awayMessage: awayMessages[m.id] || m.away_message || null });
    }
    return g;
  }, [list, presence, awayMessages]);

  async function handleRoleToggle(member: Record<string, any>) {
    if (!activeCommunity?.id || !member?.id || busyMemberId) return;
    const nextRole = member.role === 'admin' ? 'member' : 'admin';
    setBusyMemberId(member.id);
    try {
      await updateCommunityMemberRole(activeCommunity.id, member.id, nextRole);
    } finally {
      setBusyMemberId((current) => (current === member.id ? null : current));
    }
  }

  return (
    <aside className={`${styles.list} memberList`} aria-label="Community members" data-testid="member-list">
      <div className={styles.header} data-testid="member-list-header">{label} <span className={styles.count}>{list.length}</span></div>
      <div className={styles.scroll} data-testid="member-list-scroll">
        {PRESENCE_STATUSES.map(status => {
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
                  canManageRoles={canManageRoles}
                  roleBusy={busyMemberId === m.id}
                  onRoleToggle={() => { void handleRoleToggle(m); }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const MemberRow = memo(function MemberRow({
  member,
  isYou,
  canManageRoles,
  roleBusy,
  onRoleToggle,
}: {
  member: Record<string, any>,
  isYou: boolean,
  canManageRoles?: boolean,
  roleBusy?: boolean,
  onRoleToggle?: () => void,
}) {
  const name = member.displayName || member.display_name || member.username;
  const canToggleRole = Boolean(
    canManageRoles && member.role && member.role !== 'owner'
  );
  const roleActionLabel = member.role === 'admin' ? 'Remove admin' : 'Make admin';
  return (
    <div className={styles.row} title={`${name}${isYou ? ' (you)' : ''} · ${member.role}`} data-testid={`member-row-${member.id}`} data-member-id={member.id} data-member-status={member.status}>
      <div className={styles.avatarWrap}>
        <Avatar user={member} name={name} size={30} />
        <span className={`${styles.dot} ${styles[member.status]}`} />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>
          {name}
          {isYou && <span className={styles.you}>you</span>}
        </span>
        {member.status === 'away' && member.awayMessage && (
          <span className={styles.awayMessage} title={member.awayMessage}>{member.awayMessage}</span>
        )}
        {member.role && member.role !== 'member' && (
          <span className={styles.role}>{member.role}</span>
        )}
      </div>
      {canToggleRole && (
        <button
          type="button"
          className={styles.roleAction}
          onClick={onRoleToggle}
          disabled={roleBusy}
          data-testid={`member-role-toggle-${member.id}`}
        >
          {roleBusy ? 'Saving…' : roleActionLabel}
        </button>
      )}
    </div>
  );
});
