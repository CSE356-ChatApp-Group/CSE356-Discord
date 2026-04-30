import { channelCommunityId } from './chatStoreChannelHelpers';
import { removeKeyedState } from './chatStoreStateUtils';
import type { ChatStateCommunityRemovalSlice } from './chatStoreTypes';

export function removeCommunityState(
  state: ChatStateCommunityRemovalSlice,
  communityId: string,
) {
  const removedChannelIds = state.channels
    .filter((channel) => channelCommunityId(channel) === communityId)
    .map((channel) => channel.id);
  const removedSet = new Set(removedChannelIds);
  const nextMessages = removeKeyedState(state.messages, removedSet);
  const nextMessagePagination = removeKeyedState(state.messagePagination, removedSet);
  const isActiveCommunity = state.activeCommunity?.id === communityId;
  const activeChannelRemoved = state.activeChannel?.id ? removedSet.has(state.activeChannel.id) : false;

  return {
    communities: state.communities.filter((community) => community.id !== communityId),
    activeCommunity: isActiveCommunity ? null : state.activeCommunity,
    channels: isActiveCommunity ? [] : state.channels,
    activeChannel: isActiveCommunity || activeChannelRemoved ? null : state.activeChannel,
    members: isActiveCommunity ? [] : state.members,
    messages: nextMessages,
    messagePagination: nextMessagePagination,
  };
}
