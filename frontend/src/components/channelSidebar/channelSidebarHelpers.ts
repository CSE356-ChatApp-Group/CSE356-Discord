import { getEntityUnreadCount, isConversationUnread } from '../../lib/unread';

export function canManageChannels(community: unknown) {
  const role = (community as { my_role?: string; myRole?: string })?.my_role || (community as { myRole?: string })?.myRole;
  return role === 'owner' || role === 'admin';
}

export function canLeaveCommunity(community: unknown) {
  if (!community) return false;
  const role = (community as { my_role?: string; myRole?: string })?.my_role || (community as { myRole?: string })?.myRole;
  return Boolean(role && role !== 'owner');
}

export function isCommunityOwner(community: unknown) {
  if (!community) return false;
  const role = (community as { my_role?: string; myRole?: string })?.my_role || (community as { myRole?: string })?.myRole;
  return role === 'owner';
}

export function getChannelUnreadCount(channel: any, active: boolean, currentUserId: string | undefined): number {
  const canAccess = channel?.can_access ?? channel?.canAccess ?? !channel?.is_private;
  if (!canAccess) return 0;
  return getEntityUnreadCountWithFallbackLocal(channel, active, currentUserId);
}

export function getConversationUnreadCount(conv: any, active: boolean, currentUserId: string | undefined): number {
  return getEntityUnreadCountWithFallbackLocal(conv, active, currentUserId);
}

function getEntityUnreadCountWithFallbackLocal(entity: any, active: boolean, currentUserId: string | undefined): number {
  if (isConversationUnread(entity, active, currentUserId)) {
    return getEntityUnreadCount(entity, active) || 1;
  }
  return 0;
}
