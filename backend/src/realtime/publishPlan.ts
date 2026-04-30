/**
 * Typed entry points for POST /messages realtime fanout.
 * Documents channel vs conversation paths; delegates to existing implementations.
 */

"use strict";

/**
 * Channel `message:created` after commit — same as {@link publishChannelMessageCreated}.
 */
async function publishChannelMessageCreatedPlan(
  publishChannelMessageCreated: (
    channelId: string,
    envelope: Record<string, unknown>,
    opts: { communityId?: string | null },
  ) => Promise<unknown>,
  channelId: string,
  envelope: Record<string, unknown>,
  opts: { communityId?: string | null },
) {
  return publishChannelMessageCreated(channelId, envelope, opts);
}

/**
 * Conversation `message:created` — same as {@link publishConversationEventNow} for message events.
 */
async function publishConversationMessageCreatedPlan(
  publishConversationEventNow: (
    conversationId: string,
    event: string,
    data: unknown,
  ) => Promise<string | void>,
  conversationId: string,
  messageRow: unknown,
) {
  return publishConversationEventNow(conversationId, "message:created", messageRow);
}

module.exports = {
  publishChannelMessageCreatedPlan,
  publishConversationMessageCreatedPlan,
};
