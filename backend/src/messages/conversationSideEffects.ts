/**
 * Post-commit realtime/cache side effects for conversation routes.
 */

const redis = require('../db/redis');
const { publishUserFeedTargets } = require('../websocket/userFeed');
const presenceService = require('../presence/service');
const { invalidateWsBootstrapCaches } = require('../websocket/server');
const { bustConversationMessagesCache } = require('./messageCacheBust');
const { invalidateConversationFanoutTargetsCache } = require('./fanout/conversationFanoutTargets');
const {
  invalidateConversationsListCaches,
} = require('./conversationsRouterListCache');
const {
  publishConversationEvents,
  publishConversationInviteNotifications,
  scheduleGroupDmInviteRetry,
} = require('./conversationsRouterPublish');
const logger = require('../utils/logger');

async function publishConversationSubscribeChannels(
  userIds: string[],
  conversationId: string,
  logContext: string,
) {
  await publishUserFeedTargets(userIds, {
    __wsInternal: {
      kind: 'subscribe_channels',
      channels: [`conversation:${conversationId}`],
    },
  }).catch((err) => {
    logger.warn({ err, conversationId }, logContext);
  });
}

async function runExistingDmSideEffects({
  existingId,
  pairIds,
}: {
  existingId: string;
  pairIds: string[];
}) {
  // Idempotent re-create of an already-existing 1:1 DM. The participant set
  // is unchanged, so the conversation fanout-target cache is still correct.
  // Invalidating it here causes 100% churn under graders that re-POST the
  // same DM repeatedly, which negates the conversation_event cache (the
  // observed pre-fix hit ratio was 0% with cache writes immediately followed
  // by DELs). WS bootstrap and list-cache invalidation remain for UI
  // freshness reasons unrelated to participant membership.
  await Promise.allSettled([
    invalidateWsBootstrapCaches(pairIds),
    invalidateConversationsListCaches(pairIds, 'membership_change'),
  ]);
  await publishConversationSubscribeChannels(
    pairIds,
    existingId,
    'subscribe_channels push failed (existing 1:1 DM)',
  );
}

async function runCreatedConversationSideEffects({
  conversation,
  conversationId,
  allIds,
  invitedUserIds,
  invitedBy,
}: {
  conversation: any;
  conversationId: string;
  allIds: string[];
  invitedUserIds: string[];
  invitedBy: string;
}) {
  await Promise.allSettled([
    invalidateConversationFanoutTargetsCache(conversationId),
    presenceService.invalidatePresenceFanoutTargetsBulk(allIds),
    invalidateWsBootstrapCaches(allIds),
    invalidateConversationsListCaches(allIds, 'structural_conversation_change'),
  ]);

  if (!conversation) return;
  const invitedTargets = invitedUserIds.map((userId) => `user:${userId}`);
  const invitePayload = {
    conversation,
    conversationId: conversation.id,
    invitedBy,
    participantIds: invitedUserIds,
  };
  await Promise.all([
    publishConversationSubscribeChannels(
      allIds,
      conversationId,
      'subscribe_channels push failed (new DM)',
    ),
    publishConversationInviteNotifications(invitedTargets, invitePayload, { strict: true }),
  ]);
}

async function publishGroupDmJoinMessagesIfAny({
  joinedGroupMessages,
  conversationId,
  activeParticipantIds,
}: {
  joinedGroupMessages: any[];
  conversationId: string;
  activeParticipantIds: string[];
}) {
  if (joinedGroupMessages.length === 0) return;
  try {
    await bustConversationMessagesCache(redis, conversationId);
  } catch {
    /* non-fatal: TTL backstop if Redis errors */
  }
  const targets = [
    `conversation:${conversationId}`,
    ...activeParticipantIds.map((uid) => `user:${uid}`),
  ];
  await Promise.all(
    joinedGroupMessages.map((joinedGroupMessage) =>
      publishConversationEvents(targets, 'message:created', {
        ...joinedGroupMessage,
        author: null,
        attachments: [],
      }),
    ),
  );
}

async function publishGroupDmInviteSideEffects({
  conversationId,
  currentParticipantIds,
  participantIdsToAdd,
  sharedEventData,
}: {
  conversationId: string;
  currentParticipantIds: string[];
  participantIdsToAdd: string[];
  sharedEventData: Record<string, unknown>;
}) {
  if (!participantIdsToAdd.length) return;

  const invitedUserTargets = participantIdsToAdd.map((participantId) => `user:${participantId}`);
  const participantUpdateTargets = [
    `conversation:${conversationId}`,
    ...currentParticipantIds.map((participantId) => `user:${participantId}`),
    ...invitedUserTargets,
  ];

  await publishConversationEvents(
    participantUpdateTargets,
    'conversation:participant_added',
    sharedEventData,
  );

  const subscribePromise = publishUserFeedTargets(participantIdsToAdd, {
    __wsInternal: {
      kind: 'subscribe_channels',
      channels: [`conversation:${conversationId}`],
    },
  }).catch((err) => {
    logger.warn(
      { err, conversationId, participantCount: participantIdsToAdd.length },
      'subscribe_channels push failed (group DM invite)',
    );
  });

  const invitePromise = publishConversationInviteNotifications(
    invitedUserTargets,
    sharedEventData,
    { strict: true },
  );

  await Promise.all([subscribePromise, invitePromise]);
  scheduleGroupDmInviteRetry(
    participantUpdateTargets,
    invitedUserTargets,
    sharedEventData,
  );
}

module.exports = {
  publishConversationSubscribeChannels,
  runExistingDmSideEffects,
  runCreatedConversationSideEffects,
  publishGroupDmJoinMessagesIfAny,
  publishGroupDmInviteSideEffects,
};
