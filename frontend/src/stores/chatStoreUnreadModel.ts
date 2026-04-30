import type { Entity } from './chatStoreTypes';

export function channelLastMessageId(channel: Entity) {
  return channel?.last_message_id || channel?.lastMessageId || null;
}

export function channelLastMessageAuthorId(channel: Entity) {
  return channel?.last_message_author_id || channel?.lastMessageAuthorId || null;
}

export function channelMyLastReadMessageId(channel: Entity) {
  return channel?.my_last_read_message_id || channel?.myLastReadMessageId || null;
}

export function conversationLastMessageId(conversation: Entity) {
  return conversation?.last_message_id || conversation?.lastMessageId || null;
}

export function conversationLastMessageAuthorId(conversation: Entity) {
  return conversation?.last_message_author_id || conversation?.lastMessageAuthorId || null;
}

export function conversationMyLastReadMessageId(conversation: Entity) {
  return conversation?.my_last_read_message_id || conversation?.myLastReadMessageId || null;
}

export function normalizeConversationUnreadMetadata(
  conversation: Entity,
  currentUserId?: string,
): Entity {
  const hasActivity = Boolean(conversation?.has_new_activity ?? conversation?.hasNewActivity);
  const rawCount = Number(conversation?.unread_message_count ?? 0);
  if (rawCount > 0 || hasActivity) {
    return {
      ...conversation,
      unread_message_count: Math.max(0, rawCount),
      has_new_activity: hasActivity,
      hasNewActivity: hasActivity,
    };
  }

  const lastMessageId = conversationLastMessageId(conversation);
  const authoredByMe = Boolean(
    currentUserId
    && conversationLastMessageAuthorId(conversation)
    && conversationLastMessageAuthorId(conversation) === currentUserId,
  );
  const unread =
    Boolean(lastMessageId)
    && !authoredByMe
    && conversationMyLastReadMessageId(conversation) !== lastMessageId;
  return {
    ...conversation,
    unread_message_count: unread ? 1 : 0,
    has_new_activity: unread,
    hasNewActivity: unread,
  };
}

export function isChannelUnreadForUser(
  channel: Entity,
  currentUserId?: string,
  activeChannelId?: string | null,
) {
  if (!channel || !currentUserId) return false;
  if (activeChannelId && channel.id === activeChannelId) return false;
  const lastMessageId = channelLastMessageId(channel);
  if (!lastMessageId) return false;
  if (channelLastMessageAuthorId(channel) === currentUserId) return false;
  return channelMyLastReadMessageId(channel) !== lastMessageId;
}

export function countUnreadChannels(
  channels: Entity[],
  currentUserId?: string,
  activeChannelId?: string | null,
) {
  if (!currentUserId || !Array.isArray(channels)) return 0;
  return channels.reduce(
    (count, channel) =>
      count + (isChannelUnreadForUser(channel, currentUserId, activeChannelId) ? 1 : 0),
    0,
  );
}

export function patchConversationRowById(
  conversations: Entity[],
  conversationId: string,
  patch: Record<string, unknown>,
): Entity[] {
  const idx = conversations.findIndex((c) => c.id === conversationId);
  if (idx === -1) return conversations;
  const next = [...conversations];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

/** Immutable single-row patch by channel id; returns original ref if id not found. */
export function patchChannelRowById(
  channels: Entity[],
  channelId: string,
  patch: Record<string, unknown>,
): Entity[] {
  const idx = channels.findIndex((c) => c.id === channelId);
  if (idx === -1) return channels;
  const next = [...channels];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

export function isVisibleConversation(conv: Entity, currentUserId?: string) {
  if (!conv) return false;
  if (!currentUserId) return true;
  if (conv.is_group) return true;
  const participants = Array.isArray(conv.participants) ? conv.participants : [];
  return participants.some((participant: Entity) => participant?.id && participant.id !== currentUserId);
}

export function entityLastReadMessageId(entity?: Entity | null) {
  return entity?.my_last_read_message_id || entity?.myLastReadMessageId || null;
}

export function entityAlreadyReadAtOrBeyond(
  entity: Entity | undefined | null,
  messages: Entity[] | undefined,
  candidateMessageId: string,
) {
  const lastReadId = entityLastReadMessageId(entity);
  if (!lastReadId) return false;
  if (lastReadId === candidateMessageId) return true;

  const list = messages || [];
  const readIdx = list.findIndex((message) => message?.id === lastReadId);
  const candidateIdx = list.findIndex((message) => message?.id === candidateMessageId);
  return readIdx !== -1 && candidateIdx !== -1 && readIdx >= candidateIdx;
}
