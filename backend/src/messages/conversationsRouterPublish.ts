/**
 * Realtime publish helpers for conversations router (fanout + userfeed).
 */

const fanout = require('../websocket/fanout');
const {
  publishUserFeedTargets,
  splitUserTargets,
  userFeedRedisChannelForUserId,
  userFeedEnvelope,
} = require('../websocket/userFeed');
const { wrapFanoutPayload } = require('./realtimePayload');
const logger = require('../utils/logger');

const INVITE_NOTIFICATION_RETRY_DELAY_MS = 75;

function publishConversationEvents(targets, event, data) {
  const uniqueTargets = [...new Set(targets.filter(Boolean))];
  const payload = wrapFanoutPayload(event, data);
  const { userIds, passthroughTargets } = splitUserTargets(uniqueTargets);
  const tasks: Promise<unknown>[] = [];
  if (passthroughTargets.length) {
    tasks.push(
      fanout.publishBatch(
        passthroughTargets.map((target) => ({ channel: target, payload })),
      ),
    );
  }
  if (userIds.length > 0) {
    tasks.push(publishUserFeedTargets(userIds, payload));
  }
  return Promise.allSettled(tasks);
}

async function publishConversationEventsStrict(targets, event, data) {
  const uniqueTargets = [...new Set(targets.filter(Boolean))];
  if (!uniqueTargets.length) return;

  const payload = wrapFanoutPayload(event, data);
  const { userIds, passthroughTargets } = splitUserTargets(uniqueTargets);

  const parallel: Promise<unknown>[] = [];
  if (passthroughTargets.length) {
    parallel.push(
      fanout.publishBatch(
        passthroughTargets.map((target) => ({ channel: target, payload })),
      ),
    );
  }
  if (userIds.length > 0) {
    parallel.push(publishUserFeedTargets(userIds, payload));
  }
  await Promise.all(parallel);
}

async function publishConversationInviteNotifications(
  targets,
  data,
  options: { strict?: boolean } = {}
) {
  // Emit compatibility aliases because different clients/tests may listen for
  // either invited/invite/created when a user is added to a DM conversation.
  const inviteEvents = ['conversation:invited', 'conversation:invite', 'conversation:created', 'dm:invite'];
  const payloads = inviteEvents.map((event) => wrapFanoutPayload(event, data));
  const uniqueTargets = [...new Set((Array.isArray(targets) ? targets : []).filter(Boolean))];
  if (!uniqueTargets.length) return;

  const { userIds, passthroughTargets } = splitUserTargets(uniqueTargets);
  const entries: Array<{ channel: string; payload: unknown }> = [];
  for (const target of passthroughTargets) {
    for (const p of payloads) {
      entries.push({ channel: target, payload: p });
    }
  }
  const shardGroups = new Map<string, string[]>();
  for (const userId of userIds) {
    const shardChannel = userFeedRedisChannelForUserId(userId);
    if (!shardGroups.has(shardChannel)) shardGroups.set(shardChannel, []);
    shardGroups.get(shardChannel)!.push(userId);
  }
  for (const [shardChannel, shardUserIds] of shardGroups) {
    for (const p of payloads) {
      entries.push({
        channel: shardChannel,
        payload: userFeedEnvelope(shardUserIds, p),
      });
    }
  }
  if (!entries.length) return;

  if (options.strict) {
    await fanout.publishBatch(entries);
    return;
  }
  // Legacy non-strict: tolerate partial failure like the old Promise.allSettled path.
  try {
    await fanout.publishBatch(entries);
  } catch {
    /* best-effort */
  }
}

function scheduleGroupDmInviteRetry(participantUpdateTargets, invitedUserTargets, data) {
  const uniqueParticipantTargets = [...new Set(
    (Array.isArray(participantUpdateTargets) ? participantUpdateTargets : []).filter(Boolean)
  )];
  const uniqueInviteTargets = [...new Set(
    (Array.isArray(invitedUserTargets) ? invitedUserTargets : []).filter(Boolean)
  )];
  if (!uniqueParticipantTargets.length && !uniqueInviteTargets.length) return;

  setTimeout(() => {
    Promise.allSettled([
      uniqueParticipantTargets.length
        ? publishConversationEventsStrict(
          uniqueParticipantTargets,
          'conversation:participant_added',
          data
        )
        : Promise.resolve(),
      uniqueInviteTargets.length
        ? publishConversationInviteNotifications(uniqueInviteTargets, data, { strict: true })
        : Promise.resolve(),
    ]).then((results) => {
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') {
        logger.warn(
          {
            err: rejected.reason,
            participantTargetCount: uniqueParticipantTargets.length,
            inviteTargetCount: uniqueInviteTargets.length,
            conversationId: data?.conversationId,
          },
          'group DM invite realtime retry failed',
        );
      }
    }).catch(() => {});
  }, INVITE_NOTIFICATION_RETRY_DELAY_MS);
}

module.exports = {
  publishConversationEvents,
  publishConversationEventsStrict,
  publishConversationInviteNotifications,
  scheduleGroupDmInviteRetry,
};
