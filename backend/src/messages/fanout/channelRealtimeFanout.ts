/**
 * Channel message fanout — publish to `channel:<id>` (primary path for scale),
 * then optionally duplicate to each visible member's `user:<id>` (grading / legacy).
 */


const redis = require('../../db/redis');
const fanout = require('../../websocket/fanout');
const { tracer, trace } = require('../../utils/tracer');
const { SpanStatusCode } = require('@opentelemetry/api');
const { publishUserFeedTargets } = require('../../websocket/userFeed');
const { publishCommunityFeedMessage } = require('../../websocket/communityFeed');
const {
  channelRealtimeConfig,
  channelMessageUserFanoutEnabled,
} = require('../config/channelRealtimeConfig');
const { resolveChannelUserFanoutMode } = require('../../websocket/profile');
const {
  getChannelUserFanoutTargetKeys,
  getChannelUserFanoutTargetKeysWithMeta,
  getChannelRealtimeMeta,
  getCommunityChannelIds,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
} = require('./channelFanoutTargetsStore');
const sideEffects = require('../sideEffects');
const { enqueuePendingMessageForUsers } = require('../pending/realtimePending');
const {
  channelRecentConnectKey,
  channelRecentZsetEnabled,
  WS_RECENT_CONNECT_TTL_SECONDS,
} = require('../../websocket/recentConnect');
const {
  resolveRecentConnectTargets,
  invalidateRecentConnectTargetsCache,
} = require('./channelRecentConnectTargets');
const logger = require('../../utils/logger');
const {
  fanoutRecipientsHistogram,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
  fanoutTargetCandidatesHistogram,
  channelMessageFanoutRecipientTotal,
  realtimeMissAttributionTotal,
  wsFanoutCandidateCountBucket,
  wsActiveSubscriberTargetsBucket,
  wsFanoutActiveTargetHitTotal,
  wsFanoutActiveTargetMissTotal,
  wsFanoutRecoveryAsyncTotal,
} = require('../../utils/metrics');

const {
  CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX,
  CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST,
  MESSAGE_USER_FANOUT_HTTP_BLOCKING,
  CHANNEL_MESSAGE_USER_FANOUT_MAX,
} = channelRealtimeConfig;

async function publishUserTopicTargets(
  targets: string[],
  envelope: Record<string, unknown>,
  path: string,
) {
  if (!targets.length) return;
  return tracer.startActiveSpan('fanout.publish_userfeed', async (span: any) => {
    span.setAttribute('fanout.recipient_count', targets.length);
    try {
      const publishStartedAt = process.hrtime.bigint();
      fanoutPublishTargetsHistogram.observe({ path }, targets.length);
      fanoutRecipientsHistogram.observe({ channel_type: 'user' }, targets.length);
      await publishUserFeedTargets(targets, envelope);
      fanoutPublishDurationMs.observe(
        { path, stage: 'publish' },
        Number(process.hrtime.bigint() - publishStartedAt) / 1e6,
      );
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as any)?.message || '') });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

function isChannelMessageLiveEvent(envelope: Record<string, unknown>) {
  const event = envelope?.event;
  return typeof event === 'string' && event.startsWith('message:');
}

async function resolveRecentChannelUserTargets(channelId: string, limit: number) {
  if (!channelRecentZsetEnabled()) return [];
  try {
    const since = Date.now() - WS_RECENT_CONNECT_TTL_SECONDS * 1000;
    const recentUserIds = await redis.zrangebyscore(
      channelRecentConnectKey(channelId),
      since,
      '+inf',
    );
    return Array.from(
      new Set(
        (Array.isArray(recentUserIds) ? recentUserIds : [])
          .filter((userId) => typeof userId === 'string' && userId.length > 0)
          .slice(0, Math.max(0, limit))
          .map((userId) => `user:${userId}`),
      ),
    );
  } catch (err) {
    wsFanoutRecoveryAsyncTotal.inc({ reason: 'recent_connect_bridge_lookup_failed' });
    logger.warn(
      { err, channelId },
      'Recent-connect active subscriber lookup failed; relying on channel topic and replay',
    );
    return [];
  }
}

async function resolveUserTopicTargets(channelId: string, envelope: Record<string, unknown>) {
  if (!channelMessageUserFanoutEnabled()) {
    return {
      allTargets: [],
      recentTargets: [],
      candidateCount: 0,
      cacheResult: 'miss' as const,
      pendingEnqueueTargets: [] as string[],
    };
  }

  const mode = resolveChannelUserFanoutMode();
  if (isChannelMessageLiveEvent(envelope)) {
    const bridgeLimit = Math.min(
      CHANNEL_MESSAGE_USER_FANOUT_MAX,
      CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX,
    );
    const recentTargets = envelope?.event === 'message:created'
      ? await resolveRecentChannelUserTargets(channelId, bridgeLimit)
      : [];
    const candidateCount = 1 + recentTargets.length;
    fanoutTargetCandidatesHistogram.observe(
      { path: 'channel_message_active_subscribers' },
      candidateCount,
    );
    wsFanoutCandidateCountBucket.observe(
      { path: 'channel_message_active_subscribers' },
      candidateCount,
    );
    wsActiveSubscriberTargetsBucket.observe(
      { path: 'channel_message_recent_connect_bridge' },
      recentTargets.length,
    );
    wsFanoutActiveTargetHitTotal.inc({ path: 'channel_message' });
    if (!recentTargets.length) {
      wsFanoutActiveTargetMissTotal.inc({ path: 'channel_message_recent_connect_bridge' });
    }
    return {
      allTargets: recentTargets,
      recentTargets,
      candidateCount,
      cacheResult: 'hit' as const,
      pendingEnqueueTargets: recentTargets,
    };
  }

  const candidateMetricPath =
    mode === 'all'
      ? 'channel_message_user_topics'
      : 'channel_message_recent_connect_user_topics';
  const startedAt = process.hrtime.bigint();
  const lookupStartedAt = startedAt;
  const targetLookup = await tracer.startActiveSpan('fanout.target_lookup', async (span: any) => {
    try {
      return await getChannelUserFanoutTargetKeysWithMeta(channelId);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as any)?.message || '') });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
  const targets = targetLookup.targets;
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'target_lookup' },
    Number(process.hrtime.bigint() - lookupStartedAt) / 1e6,
  );
  const cap = CHANNEL_MESSAGE_USER_FANOUT_MAX;
  const capped = targets.slice(0, Math.min(cap, targets.length));
  fanoutTargetCandidatesHistogram.observe({ path: candidateMetricPath }, capped.length);

  if (!capped.length) {
    fanoutPublishDurationMs.observe(
      { path: 'channel_message_user_topics', stage: 'total' },
      Number(process.hrtime.bigint() - startedAt) / 1e6,
    );
    return {
      allTargets: [],
      recentTargets: [],
      candidateCount: 0,
      cacheResult: targetLookup.cacheResult,
      pendingEnqueueTargets: [],
    };
  }

  if (mode === 'all') {
    fanoutPublishDurationMs.observe(
      { path: 'channel_message_user_topics', stage: 'total' },
      Number(process.hrtime.bigint() - startedAt) / 1e6,
    );
    return {
      allTargets: capped,
      recentTargets: [],
      candidateCount: capped.length,
      cacheResult: targetLookup.cacheResult,
      pendingEnqueueTargets: capped,
    };
  }

  const recentLookupStartedAt = process.hrtime.bigint();
  const inlineTargets = await resolveRecentConnectTargets(channelId, capped);
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_recent_connect_user_topics', stage: 'target_lookup' },
    Number(process.hrtime.bigint() - recentLookupStartedAt) / 1e6,
  );
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'total' },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );

  return {
    allTargets: inlineTargets,
    recentTargets: inlineTargets,
    candidateCount: capped.length,
    cacheResult: targetLookup.cacheResult,
    pendingEnqueueTargets: capped,
  };
}

async function publishDeferredUserTopics(
  targets: string[],
  envelope: Record<string, unknown>,
) {
  await publishUserTopicTargets(targets, envelope, 'channel_message_user_topics');
}

async function publishChannelMessageRecentUserBridge(
  channelId: string,
  envelope: Record<string, unknown>,
) {
  if (envelope?.event !== 'message:created') {
    return { targetCount: 0 };
  }
  if (!channelMessageUserFanoutEnabled() || !channelRecentZsetEnabled()) {
    return { targetCount: 0 };
  }

  const targets = await resolveRecentChannelUserTargets(
    channelId,
    CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX,
  );
  if (!targets.length) {
    return { targetCount: 0 };
  }

  enqueuePendingMessageForUsers(targets, envelope, { recentTargets: targets }).catch((err) => {
    logger.warn(
      { err, channelId, targetCount: targets.length },
      'Failed to enqueue immediate recent-connect bridge pending replay pointers',
    );
  });
  await publishUserTopicTargets(
    targets,
    envelope,
    'channel_message_immediate_recent_bridge_user_topics',
  );
  return { targetCount: targets.length };
}

/**
 * Publishes message:created for a channel. Order: optional `channel:<id>` first,
 * then user topics (blocking or via side-effect queue).
 */
async function publishChannelMessageEvent(
  channelId: string,
  envelope: Record<string, unknown>,
  opts: { communityId?: string | null; isPrivate?: boolean | null } = {},
) {
  const chKey = `channel:${channelId}`;
  const firstChannel = CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST;
  const startedAt = process.hrtime.bigint();
  const mode = resolveChannelUserFanoutMode();
  // Start resolving the logical user audience immediately, but don't make the
  // explicit `channel:` publish wait for that lookup when channel-first mode is
  // enabled. This preserves the existing payload contract while reducing
  // avoidable latency for rich clients already listening on `channel:<id>`.
  const userTargetsPromise = resolveUserTopicTargets(channelId, envelope);
  let allTargets: string[] = [];
  let pendingEnqueueTargets: string[] = [];
  let hintedRecentTargets: string[] = [];
  let candidateCount = 0;
  let cacheResult: 'hit' | 'miss' | 'coalesced' = 'miss';

  async function publishChannelTopicOnly() {
    return tracer.startActiveSpan('fanout.publish_passthrough', async (span: any) => {
      try {
        const channelPublishStartedAt = process.hrtime.bigint();
        await fanout.publish(chKey, envelope);
        fanoutPublishDurationMs.observe(
          { path: 'channel_message', stage: 'channel_topic' },
          Number(process.hrtime.bigint() - channelPublishStartedAt) / 1e6,
        );
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as any)?.message || '') });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async function publishCommunityFeedIfPublic() {
    const meta =
      opts.communityId && opts.isPrivate !== undefined && opts.isPrivate !== null
        ? { communityId: opts.communityId, isPrivate: opts.isPrivate === true }
        : await getChannelRealtimeMeta(channelId).catch((err) => {
          logger.warn({ err, channelId }, 'Failed to load channel realtime metadata');
          return { communityId: null, isPrivate: true };
        });
    if (!meta.isPrivate && meta.communityId) {
      await publishCommunityFeedMessage(meta.communityId, envelope);
    }
  }

  if (firstChannel) {
    await publishChannelTopicOnly();
  }

  ({
    allTargets,
    pendingEnqueueTargets,
    recentTargets: hintedRecentTargets,
    candidateCount,
    cacheResult,
  } = await userTargetsPromise);
  trace.getActiveSpan()?.setAttribute('fanout.recipient_count', allTargets.length);

  await publishCommunityFeedIfPublic();

  if (envelope?.event === 'message:created' && pendingEnqueueTargets.length > 0) {
    // Reconnect bridge: keep a short-lived per-user pending pointer so reconnect
    // drain can recover missed live fanout quickly before marking socket ready.
    enqueuePendingMessageForUsers(pendingEnqueueTargets, envelope, {
      recentTargets: hintedRecentTargets,
    }).catch((err) => {
      logger.warn(
        { err, channelId, targetCount: pendingEnqueueTargets.length },
        'Failed to enqueue channel message pending replay pointers',
      );
    });
  }

  const blocking = MESSAGE_USER_FANOUT_HTTP_BLOCKING;
  const recentTargets =
    mode === 'all' && !blocking
      ? await resolveRecentConnectTargets(channelId, allTargets)
      : hintedRecentTargets;
  const recentTargetSet = new Set(recentTargets);
  const inlineTargets =
    mode === 'all' && !blocking
      ? recentTargets
      : allTargets;
  const deferredTargets =
    mode === 'all' && !blocking
      ? allTargets.filter((target) => !recentTargetSet.has(target))
      : [];

  if (channelMessageUserFanoutEnabled() && envelope?.event === 'message:created') {
    channelMessageFanoutRecipientTotal.inc({ segment: 'candidate' }, candidateCount);
    channelMessageFanoutRecipientTotal.inc({ segment: 'inline_user_topic' }, inlineTargets.length);
    channelMessageFanoutRecipientTotal.inc({ segment: 'deferred_user_topic' }, deferredTargets.length);
    if (mode === 'all' && !blocking && deferredTargets.length > 0) {
      realtimeMissAttributionTotal.inc(
        { reason: 'channel_user_topic_deferred_not_recent' },
        deferredTargets.length,
      );
    }
  }

  if (inlineTargets.length > 0) {
    await publishUserTopicTargets(
      inlineTargets,
      envelope,
      mode === 'all'
        ? 'channel_message_user_topics'
        : 'channel_message_recent_connect_user_topics',
    );
  }

  if (!blocking && deferredTargets.length > 0) {
    sideEffects.enqueueFanoutJob('fanout.channel_message.user_topics', () =>
      publishDeferredUserTopics(deferredTargets, envelope),
    );
  }

  if (!firstChannel) {
    await publishChannelTopicOnly();
  }

  fanoutPublishDurationMs.observe(
    { path: 'channel_message', stage: 'total' },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );
  return {
    mode,
    cacheResult,
    candidateCount,
    inlineTargetCount: inlineTargets.length,
    deferredTargetCount: deferredTargets.length,
    totalTargetCount: allTargets.length,
  };
}

async function publishChannelMessageCreated(
  channelId: string,
  envelope: Record<string, unknown>,
  opts: { communityId?: string | null; isPrivate?: boolean | null } = {},
) {
  return publishChannelMessageEvent(channelId, envelope, opts);
}

module.exports = {
  publishChannelMessageEvent,
  publishChannelMessageCreated,
  publishChannelMessageRecentUserBridge,
  getChannelUserFanoutTargetKeys,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
  invalidateRecentConnectTargetsCache,
  getCommunityChannelIds,
};
