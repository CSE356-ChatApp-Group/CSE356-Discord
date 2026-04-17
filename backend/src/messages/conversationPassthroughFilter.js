'use strict';

/**
 * Optional narrowing of Redis passthrough topics for conversation-scoped events.
 * With WS_AUTO_SUBSCRIBE_MODE=user_only, clients rely on sharded user-feed delivery
 * for message:created; skipping the redundant conversation:<id> publish avoids
 * NUMSUB / skip-empty edge cases on that duplicate path.
 */

function canonicalUserFeedEnabled() {
  const value = String(process.env.REALTIME_CANONICAL_USER_FEED || 'true').trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

function skipConversationTopicForMessageCreatedEnabled() {
  const v = String(process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED || 'false')
    .trim()
    .toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

/**
 * @param {string} event
 * @param {string[]} passthroughTargets
 * @param {string[]} userIds
 * @returns {string[]}
 */
function conversationPassthroughTargetsForPublish(event, passthroughTargets, userIds) {
  if (event !== 'message:created') return passthroughTargets;
  if (!canonicalUserFeedEnabled() || !skipConversationTopicForMessageCreatedEnabled()) {
    return passthroughTargets;
  }
  if (!Array.isArray(userIds) || userIds.length === 0) return passthroughTargets;
  return passthroughTargets.filter(
    (t) => typeof t !== 'string' || !t.startsWith('conversation:'),
  );
}

module.exports = {
  conversationPassthroughTargetsForPublish,
};
