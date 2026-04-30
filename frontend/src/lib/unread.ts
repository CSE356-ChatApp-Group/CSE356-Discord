type Entity = Record<string, any>;

export function getEntityUnreadCount(entity: Entity, active: boolean): number {
  if (active) return 0;
  const count = Number(entity?.unread_message_count ?? 0);
  if (count === 0 && Boolean(entity?.has_new_activity ?? entity?.hasNewActivity)) return 1;
  return Math.max(0, count);
}

function isEntityUnreadByCursor(
  entity: Entity,
  active: boolean,
  currentUserId?: string,
): boolean {
  const count = getEntityUnreadCount(entity, active);
  if (count > 0) return true;
  if (active) return false;
  const lastMessageAuthorId = entity?.last_message_author_id || entity?.lastMessageAuthorId;
  const lastMessageId = entity?.last_message_id || entity?.lastMessageId;
  const myLastReadMessageId = entity?.my_last_read_message_id || entity?.myLastReadMessageId;
  if (!lastMessageId) return false;
  if (lastMessageAuthorId === currentUserId) return false;
  return myLastReadMessageId !== lastMessageId;
}

export function getEntityUnreadCountWithFallback(
  entity: Entity,
  active: boolean,
  currentUserId?: string,
): number {
  if (isEntityUnreadByCursor(entity, active, currentUserId)) {
    return getEntityUnreadCount(entity, active) || 1;
  }
  return 0;
}

export function isConversationUnread(
  conversation: Entity,
  active: boolean,
  currentUserId?: string,
): boolean {
  return getEntityUnreadCountWithFallback(conversation, active, currentUserId) > 0;
}
