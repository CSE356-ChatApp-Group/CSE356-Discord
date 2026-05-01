/**
 * WebSocket event dispatch for the chat store (extracted from chatStore.ts).
 */

import { invalidateApiCache } from "../lib/api";
import {
  runImmediateCommunityChannelsRefetch,
  scheduleDebouncedCommunityChannelsRefetch,
} from "./chatStoreSidebarSync";
import { wsManager } from "../lib/ws";
import { useAuthStore } from "./authStore";
import { removeCommunityState } from "./chatStoreCommunityRemoval";
import { loadedHistoryIncludesLatest } from "./chatStorePagination";
import {
  countUnreadChannels,
  patchChannelRowById,
} from "./chatStoreUnreadModel";
import { queueMarkMessageRead } from "./chatStoreReadReceipts";
import { upsertMessageChronologically } from "./chatStoreMessageList";
import { upsertChannel } from "./chatStoreChannelHelpers";
import { hydrateAuthorFromSession } from "./chatStoreHydrate";
import type { ChatStoreGet, ChatStoreSet, Entity } from "./chatStoreTypes";

/** Runtime WS payloads vary by `event`; keep loose `data` and narrow inside cases. */
type WsEventPayload = { event: string; data?: any };

type WsSelfRef = (event: unknown) => void;

export function createChatStoreWsHandler(
  get: ChatStoreGet,
  set: ChatStoreSet,
): (event: unknown) => void {
  const selfRef: WsSelfRef = (event) => {
    dispatchChatStoreWsEvent(event, get, set, selfRef);
  };
  return selfRef;
}

function dispatchChatStoreWsEvent(
  event: unknown,
  get: ChatStoreGet,
  set: ChatStoreSet,
  selfRef: WsSelfRef,
): void {
  const ev = event as WsEventPayload;
  switch (ev.event) {
    case "message:created": {
      const msg = hydrateAuthorFromSession(ev.data);
      const me = useAuthStore.getState().user;
      const key = msg.channel_id || msg.conversation_id;
      set((s) => {
        const paginationState = s.messagePagination[key];
        const existing = s.messages[key] || [];
        const nextMessages = {
          ...s.messages,
          [key]: upsertMessageChronologically(existing, msg),
        };

        let nextChannels = s.channels;
        let nextActiveChannel = s.activeChannel;
        let nextCommunities = s.communities;
        let nextActiveCommunity = s.activeCommunity;

        if (msg.channel_id) {
          const isViewingChannel = s.activeChannel?.id === msg.channel_id;
          const atLiveTail = Boolean(
            isViewingChannel && msg.id && !paginationState?.hasNewer,
          );
          const markReadInSamePass = atLiveTail;

          nextChannels = s.channels.map((channel) => {
            if (channel.id !== msg.channel_id) return channel;
            const isActive = s.activeChannel?.id === msg.channel_id;
            const row = {
              ...channel,
              updated_at: msg.created_at || msg.createdAt || channel.updated_at,
              updatedAt: msg.created_at || msg.createdAt || channel.updatedAt,
              last_message_id: msg.id,
              lastMessageId: msg.id,
              last_message_author_id: msg.author_id,
              lastMessageAuthorId: msg.author_id,
              last_message_at:
                msg.created_at || msg.createdAt || channel.last_message_at,
              lastMessageAt:
                msg.created_at || msg.createdAt || channel.lastMessageAt,
              has_new_activity: !isActive,
              hasNewActivity: !isActive,
              unread_message_count:
                atLiveTail && isActive
                  ? 0
                  : (channel.unread_message_count ?? 0) + 1,
            };
            if (!markReadInSamePass) return row;
            return {
              ...row,
              my_last_read_message_id: msg.id,
              myLastReadMessageId: msg.id,
              has_new_activity: false,
              hasNewActivity: false,
            };
          });

          nextActiveChannel =
            msg.channel_id && s.activeChannel?.id === msg.channel_id
              ? {
                  ...s.activeChannel,
                  updated_at:
                    msg.created_at ||
                    msg.createdAt ||
                    s.activeChannel.updated_at,
                  updatedAt:
                    msg.created_at ||
                    msg.createdAt ||
                    s.activeChannel.updatedAt,
                  last_message_id: msg.id,
                  lastMessageId: msg.id,
                  last_message_author_id: msg.author_id,
                  lastMessageAuthorId: msg.author_id,
                  last_message_at:
                    msg.created_at ||
                    msg.createdAt ||
                    s.activeChannel.last_message_at,
                  lastMessageAt:
                    msg.created_at ||
                    msg.createdAt ||
                    s.activeChannel.lastMessageAt,
                  ...(markReadInSamePass && msg.id
                    ? {
                        my_last_read_message_id: msg.id,
                        myLastReadMessageId: msg.id,
                        has_new_activity: false,
                        hasNewActivity: false,
                      }
                    : {}),
                }
              : s.activeChannel;

          const targetCh = nextChannels.find((c) => c.id === msg.channel_id);
          const communityId = targetCh?.community_id || targetCh?.communityId;
          if (communityId) {
            const unreadCount = countUnreadChannels(
              nextChannels,
              me?.id,
              s.activeChannel?.id,
            );
            nextCommunities = s.communities.map((community) =>
              community.id === communityId
                ? {
                    ...community,
                    unread_channel_count: unreadCount,
                    unreadChannelCount: unreadCount,
                    has_unread_channels: unreadCount > 0,
                    hasUnreadChannels: unreadCount > 0,
                    has_new_activity: s.activeCommunity?.id !== communityId,
                    hasNewActivity: s.activeCommunity?.id !== communityId,
                  }
                : community,
            );
            if (s.activeCommunity?.id === communityId) {
              nextActiveCommunity = {
                ...s.activeCommunity,
                unread_channel_count: unreadCount,
                unreadChannelCount: unreadCount,
                has_unread_channels: unreadCount > 0,
                hasUnreadChannels: unreadCount > 0,
                has_new_activity: false,
                hasNewActivity: false,
              };
            }
          }
        }

        let nextConversations = s.conversations;
        let nextActiveConv = s.activeConv;

        if (msg.conversation_id) {
          const next = [...s.conversations];
          const idx = next.findIndex((c) => c.id === msg.conversation_id);
          const viewingDm = s.activeConv?.id === msg.conversation_id;
          const dmAtLiveTail = Boolean(
            viewingDm && msg.id && !paginationState?.hasNewer,
          );
          if (idx !== -1) {
            const updatedAt =
              msg.created_at || msg.createdAt || new Date().toISOString();
            const updated = {
              ...next[idx],
              updated_at: updatedAt,
              updatedAt,
              last_message_id: msg.id,
              lastMessageId: msg.id,
              last_message_author_id: msg.author_id,
              lastMessageAuthorId: msg.author_id,
              last_message_at: updatedAt,
              lastMessageAt: updatedAt,
              has_new_activity: !viewingDm,
              hasNewActivity: !viewingDm,
              unread_message_count:
                dmAtLiveTail && viewingDm
                  ? 0
                  : (next[idx].unread_message_count ?? 0) + 1,
              ...(dmAtLiveTail
                ? {
                    my_last_read_message_id: msg.id,
                    myLastReadMessageId: msg.id,
                    has_new_activity: false,
                    hasNewActivity: false,
                  }
                : {}),
            };
            next.splice(idx, 1);
            next.unshift(updated);
            nextConversations = next;
          }
          nextActiveConv =
            msg.conversation_id && s.activeConv?.id === msg.conversation_id
              ? {
                  ...s.activeConv,
                  updated_at:
                    msg.created_at || msg.createdAt || s.activeConv.updated_at,
                  updatedAt:
                    msg.created_at || msg.createdAt || s.activeConv.updatedAt,
                  last_message_id: msg.id,
                  lastMessageId: msg.id,
                  last_message_author_id: msg.author_id,
                  lastMessageAuthorId: msg.author_id,
                  last_message_at:
                    msg.created_at ||
                    msg.createdAt ||
                    s.activeConv.last_message_at,
                  lastMessageAt:
                    msg.created_at ||
                    msg.createdAt ||
                    s.activeConv.lastMessageAt,
                  has_new_activity: !viewingDm,
                  hasNewActivity: !viewingDm,
                  unread_message_count:
                    dmAtLiveTail && viewingDm
                      ? 0
                      : (s.activeConv.unread_message_count ?? 0) + 1,
                  ...(dmAtLiveTail
                    ? {
                        my_last_read_message_id: msg.id,
                        myLastReadMessageId: msg.id,
                        has_new_activity: false,
                        hasNewActivity: false,
                      }
                    : {}),
                }
              : s.activeConv;
        }

        return {
          messages: nextMessages,
          channels: nextChannels,
          activeChannel: nextActiveChannel,
          conversations: nextConversations,
          activeConv: nextActiveConv,
          communities: nextCommunities,
          activeCommunity: nextActiveCommunity,
        };
      });

      const st = get();
      if (
        msg.channel_id &&
        st.activeChannel?.id === msg.channel_id &&
        msg.id &&
        loadedHistoryIncludesLatest(st, msg.channel_id)
      ) {
        queueMarkMessageRead(msg.id, {
          channelId: msg.channel_id,
          coalesce: true,
          messageCreatedAt: msg.created_at || msg.createdAt,
        });
      }
      if (
        msg.conversation_id &&
        st.activeConv?.id === msg.conversation_id &&
        msg.id &&
        loadedHistoryIncludesLatest(st, msg.conversation_id)
      ) {
        queueMarkMessageRead(msg.id, {
          conversationId: msg.conversation_id,
          coalesce: true,
          messageCreatedAt: msg.created_at || msg.createdAt,
        });
      }
      break;
    }
    case "message:updated": {
      const msg = hydrateAuthorFromSession(ev.data);
      const key = msg.channel_id || msg.conversation_id;
      set((s) => ({
        messages: {
          ...s.messages,
          [key]: (s.messages[key] || []).map((m) =>
            m.id === msg.id ? msg : m,
          ),
        },
      }));
      break;
    }
    case "message:deleted": {
      // Remove from all lists (we don't know which key without the full msg)
      const { id } = ev.data;
      set((s) => {
        const messages = {};
        for (const [k, msgs] of Object.entries(s.messages)) {
          messages[k] = (msgs as Entity[]).filter((m) => m.id !== id);
        }
        return { messages };
      });
      break;
    }
    case "presence:updated": {
      const { userId, status, awayMessage } = ev.data;
      get().setPresence(userId, status, awayMessage ?? null);
      const auth = useAuthStore.getState();
      if (auth.user?.id === userId) {
        auth.setUser({
          ...auth.user,
          status,
          awayMessage: status === "away" ? (awayMessage ?? null) : null,
        });
      }
      break;
    }
    case "read:updated": {
      const {
        channelId,
        conversationId,
        userId,
        lastReadMessageId,
        lastReadAt,
      } = ev.data || {};
      if (!userId || (!conversationId && !channelId)) break;
      const me = useAuthStore.getState().user;
      if (channelId && me?.id === userId) {
        set((s) => {
          const rowPatch = {
            my_last_read_message_id: lastReadMessageId,
            myLastReadMessageId: lastReadMessageId,
            my_last_read_at: lastReadAt,
            myLastReadAt: lastReadAt,
            unread_message_count: 0,
          };
          const idx = s.channels.findIndex((c) => c.id === channelId);
          const nextChannels =
            idx === -1
              ? s.channels
              : patchChannelRowById(s.channels, channelId, rowPatch);
          const communityId =
            idx === -1
              ? (s.activeCommunity?.id ?? null)
              : s.channels[idx].community_id ||
                s.channels[idx].communityId ||
                s.activeCommunity?.id;
          const unreadCount = countUnreadChannels(
            nextChannels,
            me?.id,
            s.activeChannel?.id,
          );
          return {
            channels: nextChannels,
            activeChannel:
              s.activeChannel?.id === channelId
                ? {
                    ...s.activeChannel,
                    ...rowPatch,
                  }
                : s.activeChannel,
            communities: communityId
              ? s.communities.map((community) =>
                  community.id === communityId
                    ? {
                        ...community,
                        unread_channel_count: unreadCount,
                        unreadChannelCount: unreadCount,
                        has_unread_channels: unreadCount > 0,
                        hasUnreadChannels: unreadCount > 0,
                      }
                    : community,
                )
              : s.communities,
            activeCommunity:
              communityId && s.activeCommunity?.id === communityId
                ? {
                    ...s.activeCommunity,
                    unread_channel_count: unreadCount,
                    unreadChannelCount: unreadCount,
                    has_unread_channels: unreadCount > 0,
                    hasUnreadChannels: unreadCount > 0,
                  }
                : s.activeCommunity,
          };
        });
      }
      if (!conversationId) break;
      set((s) => {
        const cidx = s.conversations.findIndex((c) => c.id === conversationId);
        if (cidx === -1) {
          return {
            conversations: s.conversations,
            activeConv: s.activeConv,
          };
        }
        const next = [...s.conversations];
        const base = next[cidx];
        next[cidx] =
          me?.id === userId
            ? {
                ...base,
                my_last_read_message_id: lastReadMessageId,
                myLastReadMessageId: lastReadMessageId,
                my_last_read_at: lastReadAt,
                myLastReadAt: lastReadAt,
                unread_message_count: 0,
                has_new_activity: false,
                hasNewActivity: false,
              }
            : {
                ...base,
                other_last_read_message_id: lastReadMessageId,
                otherLastReadMessageId: lastReadMessageId,
                other_last_read_at: lastReadAt,
                otherLastReadAt: lastReadAt,
              };
        return {
          conversations: next,
          activeConv:
            s.activeConv?.id === conversationId
              ? me?.id === userId
                ? {
                    ...s.activeConv,
                    my_last_read_message_id: lastReadMessageId,
                    myLastReadMessageId: lastReadMessageId,
                    my_last_read_at: lastReadAt,
                    myLastReadAt: lastReadAt,
                    unread_message_count: 0,
                    has_new_activity: false,
                    hasNewActivity: false,
                  }
                : {
                    ...s.activeConv,
                    other_last_read_message_id: lastReadMessageId,
                    otherLastReadMessageId: lastReadMessageId,
                    other_last_read_at: lastReadAt,
                    otherLastReadAt: lastReadAt,
                  }
              : s.activeConv,
        };
      });
      break;
    }
    case "community:role_updated": {
      const { communityId, userId } = ev.data || {};
      if (!communityId || !userId) break;
      if (get().activeCommunity?.id === communityId) {
        get()
          .fetchMembers(communityId)
          .catch(() => {});
      }
      if (useAuthStore.getState().user?.id === userId) {
        invalidateApiCache("/communities");
        get()
          .fetchCommunities()
          .catch(() => {});
      }
      break;
    }
    case "community:member_joined":
    case "community:member_left": {
      const { communityId } = ev.data;
      if (get().activeCommunity?.id === communityId) {
        get().fetchMembers(communityId);
      }
      break;
    }
    case "community:deleted": {
      const { communityId } = ev.data || {};
      if (!communityId) break;
      set((s) => removeCommunityState(s, communityId));
      break;
    }
    case "channel:created": {
      const channel = ev.data;
      if (!channel?.community_id && !channel?.communityId) break;
      const communityId = channel.community_id || channel.communityId;
      if (get().activeCommunity?.id === communityId) {
        set((s) => ({
          channels: upsertChannel(s.channels, {
            ...channel,
            _localCreatedAt: channel._localCreatedAt || Date.now(),
          }),
        }));
        scheduleDebouncedCommunityChannelsRefetch(communityId, (id) =>
          get().fetchChannels(id),
        );
      }
      break;
    }
    case "channel:updated": {
      const channel = ev.data || {};
      const communityId = channel.community_id || channel.communityId;
      const channelId = channel.id;
      if (!communityId || !channelId) break;
      const explicitAccess = channel.can_access ?? channel.canAccess;
      const previousChannel = get().channels.find(
        (existing) => existing.id === channelId,
      );
      const previousAccess =
        previousChannel?.can_access ??
        previousChannel?.canAccess ??
        !previousChannel?.is_private;
      const accessChanged =
        explicitAccess !== undefined && previousAccess !== explicitAccess;

      set((s) => {
        const previousForUpsert = s.channels.find(
          (existing) => existing.id === channelId,
        );

        let nextMessages = s.messages;
        let nextPagination = s.messagePagination;
        if (accessChanged) {
          const { [channelId]: _removedMessages, ...restMessages } = s.messages;
          const { [channelId]: _removedPagination, ...restPagination } =
            s.messagePagination;
          nextMessages = restMessages;
          nextPagination = restPagination;
        }

        return {
          channels: upsertChannel(s.channels, {
            ...(previousForUpsert || {}),
            ...channel,
          }),
          activeChannel:
            s.activeChannel?.id === channelId
              ? explicitAccess === false
                ? null
                : {
                    ...s.activeChannel,
                    ...channel,
                  }
              : s.activeChannel,
          messages: nextMessages,
          messagePagination: nextPagination,
        };
      });
      if (get().activeCommunity?.id === communityId) {
        if (accessChanged) {
          runImmediateCommunityChannelsRefetch(communityId, (id) =>
            get().fetchChannels(id),
          );
        } else {
          scheduleDebouncedCommunityChannelsRefetch(communityId, (id) =>
            get().fetchChannels(id),
          );
        }
      }
      break;
    }
    case "channel:deleted": {
      const channelId = ev.data?.id;
      const communityId = ev.data?.community_id || ev.data?.communityId;
      if (!channelId) break;
      set((s) => {
        const { [channelId]: _removed, ...nextMessages } = s.messages;
        const { [channelId]: _removedPagination, ...nextPagination } =
          s.messagePagination;
        return {
          channels: s.channels.filter((channel) => channel.id !== channelId),
          activeChannel:
            s.activeChannel?.id === channelId ? null : s.activeChannel,
          messages: nextMessages,
          messagePagination: nextPagination,
        };
      });
      if (communityId && get().activeCommunity?.id === communityId) {
        scheduleDebouncedCommunityChannelsRefetch(communityId, (id) =>
          get().fetchChannels(id),
        );
      }
      break;
    }
    case "channel:membership_updated": {
      const { communityId, channelId } = ev.data || {};
      if (channelId) {
        wsManager.subscribe(`channel:${channelId}`, selfRef);
      }
      if (communityId && get().activeCommunity?.id === communityId) {
        scheduleDebouncedCommunityChannelsRefetch(communityId, (id) =>
          get().fetchChannels(id),
        );
      }
      break;
    }
    case "community:channel_message": {
      const { communityId, channelId } = ev.data || {};
      if (!communityId || !channelId) break;

      set((s) => {
        const chIdx = s.channels.findIndex((c) => c.id === channelId);
        const coIdx = s.communities.findIndex((c) => c.id === communityId);
        const nextChannels =
          chIdx === -1
            ? s.channels
            : (() => {
                const n = [...s.channels];
                n[chIdx] = {
                  ...n[chIdx],
                  has_new_activity: s.activeChannel?.id !== channelId,
                  hasNewActivity: s.activeChannel?.id !== channelId,
                };
                return n;
              })();
        const nextCommunities =
          coIdx === -1
            ? s.communities
            : (() => {
                const n = [...s.communities];
                const prev = n[coIdx];
                n[coIdx] = {
                  ...prev,
                  has_unread_channels: true,
                  hasUnreadChannels: true,
                  unread_channel_count: Math.max(
                    Number(
                      prev.unread_channel_count ?? prev.unreadChannelCount ?? 0,
                    ),
                    1,
                  ),
                  unreadChannelCount: Math.max(
                    Number(
                      prev.unread_channel_count ?? prev.unreadChannelCount ?? 0,
                    ),
                    1,
                  ),
                  has_new_activity: s.activeCommunity?.id !== communityId,
                  hasNewActivity: s.activeCommunity?.id !== communityId,
                };
                return n;
              })();
        return {
          channels: nextChannels,
          communities: nextCommunities,
          activeCommunity:
            s.activeCommunity?.id === communityId
              ? {
                  ...s.activeCommunity,
                  has_unread_channels: true,
                  hasUnreadChannels: true,
                  unread_channel_count: Math.max(
                    Number(
                      s.activeCommunity.unread_channel_count ??
                        s.activeCommunity.unreadChannelCount ??
                        0,
                    ),
                    1,
                  ),
                  unreadChannelCount: Math.max(
                    Number(
                      s.activeCommunity.unread_channel_count ??
                        s.activeCommunity.unreadChannelCount ??
                        0,
                    ),
                    1,
                  ),
                  has_new_activity: false,
                  hasNewActivity: false,
                }
              : s.activeCommunity,
        };
      });

      break;
    }
    case "conversation:invited": {
      const conversation = ev.data?.conversation;
      const conversationId = ev.data?.conversationId || conversation?.id;
      if (!conversationId) break;

      wsManager.subscribe(`conversation:${conversationId}`, selfRef);

      if (!conversation) {
        get()
          .fetchConversations()
          .catch(() => {});
        break;
      }

      set((s) => {
        const existing = s.conversations.find(
          (conv) => conv.id === conversationId,
        );

        const updated = existing
          ? {
              ...existing,
              ...conversation,
              participants: conversation.participants || existing.participants,
            }
          : conversation;

        const conversations = existing
          ? s.conversations.map((conv) =>
              conv.id === conversationId ? updated : conv,
            )
          : [updated, ...s.conversations];

        return {
          conversations,
          activeConv:
            s.activeConv?.id === conversationId
              ? {
                  ...s.activeConv,
                  ...updated,
                  participants:
                    updated.participants || s.activeConv.participants,
                }
              : s.activeConv,
        };
      });
      break;
    }
    case "conversation:participant_added": {
      const conversation = ev.data?.conversation;
      const conversationId = ev.data?.conversationId || conversation?.id;
      if (!conversationId) break;

      wsManager.subscribe(`conversation:${conversationId}`, selfRef);

      if (!conversation) {
        get()
          .fetchConversations()
          .catch(() => {});
        break;
      }

      set((s) => {
        const existing = s.conversations.find(
          (conv) => conv.id === conversationId,
        );

        const updated = existing
          ? {
              ...existing,
              ...conversation,
              participants: conversation.participants || existing.participants,
            }
          : conversation;

        const conversations = existing
          ? s.conversations.map((conv) =>
              conv.id === conversationId ? updated : conv,
            )
          : [updated, ...s.conversations];

        return {
          conversations,
          activeConv:
            s.activeConv?.id === conversationId
              ? {
                  ...s.activeConv,
                  ...updated,
                  participants:
                    updated.participants || s.activeConv.participants,
                }
              : s.activeConv,
        };
      });
      break;
    }
    case "conversation:updated": {
      const conversation = ev.data?.conversation;
      const conversationId = ev.data?.conversationId || conversation?.id;
      if (!conversationId || !conversation) break;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, name: conversation.name } : c,
        ),
        activeConv:
          s.activeConv?.id === conversationId
            ? { ...s.activeConv, name: conversation.name }
            : s.activeConv,
      }));
      break;
    }
    case "conversation:participant_left": {
      const conversationId = ev.data?.conversationId;
      const leftUserId = ev.data?.leftUserId || ev.data?.userId;
      const me = useAuthStore.getState().user;
      if (!conversationId || !leftUserId) break;

      if (me?.id === leftUserId) {
        set((s) => ({
          conversations: s.conversations.filter(
            (conv) => conv.id !== conversationId,
          ),
          activeConv: s.activeConv?.id === conversationId ? null : s.activeConv,
          activeChannel:
            s.activeConv?.id === conversationId ? null : s.activeChannel,
        }));
        break;
      }

      set((s) => {
        const updatedParticipants = (
          s.conversations.find((conv) => conv.id === conversationId)
            ?.participants || []
        ).filter((participant) => participant.id !== leftUserId);

        const otherParticipants = updatedParticipants.filter(
          (p) => p.id !== me?.id,
        );
        if (
          otherParticipants.length === 0 &&
          !s.conversations.find((conv) => conv.id === conversationId)?.is_group
        ) {
          return {
            conversations: s.conversations.filter(
              (conv) => conv.id !== conversationId,
            ),
            activeConv:
              s.activeConv?.id === conversationId ? null : s.activeConv,
            activeChannel:
              s.activeConv?.id === conversationId ? null : s.activeChannel,
          };
        }

        return {
          conversations: s.conversations.map((conv) =>
            conv.id === conversationId
              ? { ...conv, participants: updatedParticipants }
              : conv,
          ),
          activeConv:
            s.activeConv?.id === conversationId
              ? {
                  ...s.activeConv,
                  participants: updatedParticipants,
                }
              : s.activeConv,
        };
      });
      break;
    }
  }
}
