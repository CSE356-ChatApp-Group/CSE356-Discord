/**
 * Channel message fanout — publish to `channel:<id>` (primary path for scale),
 * then optionally bridge only active/recent users to `user:<id>` during bootstrap.
 */


const redis = require('../../db/redis');
const { redisBatchSmismember } = require('../../db/redisBatch');
const { query } = require('../../db/pool');
const fanout = require('../../websocket/fanout');
const { tracer, trace } = require('../../utils/tracer');
const { SpanStatusCode } = require('@opentelemetry/api');
const { publishUserFeedTargets } = require('../../websocket/userFeed');
const { publishCommunityFeedMessage } = require('../../websocket/communityFeed');
const {
  channelRealtimeConfig,
  channelMessageUserFanoutEnabled,
  channelMessageSkipUserfeedPublishEnabled,
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
  channelBootstrapPendingKey,
  channelRecentZsetEnabled,
  WS_RECENT_CONNECT_TTL_SECONDS,
  CHANNEL_BOOTSTRAP_PENDING_TTL_SECONDS,
} = require('../../websocket/recentConnect');
const { connectedUsersKey } = require('../../websocket/presenceKeys');
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
  wsActiveSubscriberTargetsBucket,
  wsFanoutCandidateCountBucket,
  wsFanoutOfflineSkippedTotal,
  wsFanoutActiveTargetHitTotal,
  wsFanoutActiveTargetMissTotal,
  wsFanoutRecoveryAsyncTotal,
  wsRecipientDuplicateCandidatesTotal,
  wsDuplicateDeliverySuppressedTotal,
  channelMessageFanoutRecipientTotal,
  realtimeMissAttributionTotal,
  wsTargetLookupDurationMs,
} = require('../../utils/metrics');
const { getWorkerLabels } = require('../../websocket/deliveryTrace');

const {
  CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK,
  CHANNEL_MESSAGE_RECENT_CONNECT_FALLBACK_PROBE_MAX,
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
  return typeof envelope?.event === 'string' && envelope.event.startsWith('message:');
}

async function resolveRecentChannelUserTargets(channelId: string, cap: number) {
  const targets = await resolveRecentChannelUserTargetsRaw(channelId, cap);
  return filterActiveConnectedUserTargets(targets, 'channel_message_active_subscribers');
}

async function resolveRecentChannelUserTargetsRaw(channelId: string, cap: number) {
  if (!channelRecentZsetEnabled()) {
    return [];
  }
  const since = Date.now() - WS_RECENT_CONNECT_TTL_SECONDS * 1000;
  const recentUserIds = await redis.zrangebyscore(
    channelRecentConnectKey(channelId),
    since,
    '+inf',
  );
  const targets = Array.from(
    new Set(
      (Array.isArray(recentUserIds) ? recentUserIds : [])
        .filter((userId) => typeof userId === 'string' && userId.length > 0)
        .slice(0, cap)
        .map((userId) => `user:${userId}`),
    ),
  );
  return targets;
}

async function filterActiveConnectedUserTargets(targets: string[], path: string) {
  if (!targets.length) return [];
  const userIds = targets
    .map((target) => (typeof target === 'string' && target.startsWith('user:') ? target.slice(5) : ''))
    .filter((userId) => userId.length > 0);
  if (!userIds.length) return [];

  try {
    const rows = await redisBatchSmismember(redis, connectedUsersKey(), userIds);
    const activeTargets = targets.filter((_target, idx) => rows[idx] === 1);
    const skipped = targets.length - activeTargets.length;
    if (skipped > 0) {
      wsFanoutOfflineSkippedTotal?.inc?.({ path }, skipped);
    }
    return activeTargets;
  } catch (err: any) {
    const message = String(err?.message || '');
    if (!/unknown command|wrong number of arguments|SMISMEMBER/i.test(message)) {
      // Fail-open: return all targets so a transient Redis error does not
      // silently drop recent-connect fanout targets and cause delivery misses.
      wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'active_recent_filter_failed' });
      logger.warn(
        { err, targetCount: targets.length },
        'Failed to filter recent channel fanout targets by active presence',
      );
      return targets;
    }
  }

  try {
    const pipe = redis.pipeline();
    for (const userId of userIds) {
      pipe.sismember(connectedUsersKey(), userId);
    }
    const results = await pipe.exec();
    const activeTargets = targets.filter((_target, idx) => Number(results?.[idx]?.[1] || 0) === 1);
    const skipped = targets.length - activeTargets.length;
    if (skipped > 0) {
      wsFanoutOfflineSkippedTotal?.inc?.({ path }, skipped);
    }
    return activeTargets;
  } catch (err) {
    // Fail-open: return all targets so a transient Redis error does not
    // silently drop recent-connect fanout targets and cause delivery misses.
    wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'active_recent_filter_fallback_failed' });
    logger.warn(
      { err, targetCount: targets.length },
      'Failed to filter recent channel fanout targets with SISMEMBER fallback',
    );
    return targets;
  }
}

async function resolveBootstrapPendingChannelUserTargets(channelId: string, cap: number) {
  const targets = await resolveBootstrapPendingChannelUserTargetsRaw(channelId, cap);
  return filterActiveConnectedUserTargets(targets, 'channel_message_bootstrap_pending_subscribers');
}

async function resolveBootstrapPendingChannelUserTargetsRaw(channelId: string, cap: number) {
  if (!channelRecentZsetEnabled()) {
    throw new Error('channel recent ZSETs disabled; bootstrap-pending bridge unavailable');
  }
  const ttlSeconds = CHANNEL_BOOTSTRAP_PENDING_TTL_SECONDS;
  const since = Date.now() - ttlSeconds * 1000 - 1000;
  const pendingUserIds = await redis.zrangebyscore(
    channelBootstrapPendingKey(channelId),
    since,
    '+inf',
  );
  const targets = Array.from(
    new Set(
      (Array.isArray(pendingUserIds) ? pendingUserIds : [])
        .filter((userId) => typeof userId === 'string' && userId.length > 0)
        .slice(0, cap)
        .map((userId) => `user:${userId}`),
    ),
  );
  return targets;
}

async function resolveActiveConnectedChannelUserTargets(
  channelId: string,
  alreadyTargeted: Set<string>,
) {
  let connectedUserIds: string[] = [];
  try {
    const raw = await redis.smembers(connectedUsersKey());
    connectedUserIds = (Array.isArray(raw) ? raw : [])
      .filter((userId) => typeof userId === 'string' && userId.length > 0)
      .filter((userId) => !alreadyTargeted.has(`user:${userId}`))
      .slice(0, CHANNEL_MESSAGE_RECENT_CONNECT_FALLBACK_PROBE_MAX);
  } catch (err) {
    wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'active_connected_lookup_failed' });
    logger.warn({ err, channelId }, 'Failed to load active connected users for channel message bridge');
    return [];
  }

  if (!connectedUserIds.length) {
    return [];
  }

  try {
    const result = await query(
      `
        SELECT DISTINCT cm.user_id::text AS user_id
        FROM channels c
        JOIN community_members cm
          ON cm.community_id = c.community_id
        LEFT JOIN channel_members chm
          ON chm.channel_id = c.id
         AND chm.user_id = cm.user_id
        WHERE c.id = $1
          AND cm.user_id::text = ANY($2::text[])
          AND (c.is_private = FALSE OR chm.user_id IS NOT NULL)
      `,
      [channelId, connectedUserIds],
    );
    return (result.rows || [])
      .map((row) => row.user_id)
      .filter((userId) => typeof userId === 'string' && userId.length > 0)
      .map((userId) => `user:${userId}`);
  } catch (err) {
    wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'active_connected_membership_lookup_failed' });
    logger.warn(
      { err, channelId, connectedUserCount: connectedUserIds.length },
      'Failed to filter active connected users by channel membership',
    );
    return [];
  }
}

async function resolveActiveChannelMessageTargets(channelId: string) {
  const startedAt = process.hrtime.bigint();
  if (channelMessageSkipUserfeedPublishEnabled()) {
    try {
      const bootstrapPendingCandidateTargets = await resolveBootstrapPendingChannelUserTargetsRaw(
        channelId,
        CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX,
      );
      const bootstrapPendingTargets = await filterActiveConnectedUserTargets(
        bootstrapPendingCandidateTargets,
        'channel_message_bootstrap_pending_subscribers',
      );
      const bootstrapPendingLookupMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      fanoutPublishDurationMs.observe(
        { path: 'channel_message_bootstrap_pending_subscribers', stage: 'target_lookup' },
        bootstrapPendingLookupMs,
      );
      fanoutTargetCandidatesHistogram.observe(
        { path: 'channel_message_bootstrap_pending_subscribers' },
        bootstrapPendingTargets.length + 1,
      );
      // When bootstrap_pending has targets, return immediately (fast path).
      // When empty, fall through to the recent_connect ZSET lookup instead
      // of returning zero targets — the markers may have been cleared by
      // progressive hydration completing between prepare and publish, or the
      // ZSET entries may have expired. The recent_connect ZSET has a longer
      // window (5 min) and covers recently-bootstrapped users.
      if (bootstrapPendingTargets.length > 0) {
        return {
          allTargets: bootstrapPendingTargets,
          recentTargets: bootstrapPendingTargets,
          candidateCount: bootstrapPendingCandidateTargets.length + 1,
          cacheResult: 'miss' as const,
          pendingEnqueueTargets: bootstrapPendingCandidateTargets,
        };
      }
      wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'bootstrap_pending_empty_fallback' });
      if (logger.isLevelEnabled('debug')) {
        logger.debug(
          { channelId },
          'WS bootstrap_pending returned empty; falling through to recent_connect bridge',
        );
      }
      // Fall through to recent_connect + active-connected lookup below.
    } catch (err) {
      // Fail open: if the new narrow marker path cannot answer, fall back to
      // the previous active/recent bridge rather than risk a missed recipient.
      wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'bootstrap_pending_lookup_failed' });
      logger.warn(
        { err, channelId },
        'Failed to resolve bootstrap-pending channel fanout targets; falling back to active bridge',
      );
    }
  }

  const recentCandidateTargets = await resolveRecentChannelUserTargetsRaw(
    channelId,
    CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX,
  ).catch((err) => {
    wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'recent_connect_lookup_failed' });
    logger.warn({ err, channelId }, 'Failed to resolve recent channel message bridge targets');
    return [];
  });
  const recentTargets = await filterActiveConnectedUserTargets(
    recentCandidateTargets,
    'channel_message_active_subscribers',
  );
  const targetSet = new Set(recentTargets);

  // Connected fallback only runs when explicitly enabled via config flag.
  // Previously this also fired when both ZSETs were empty (d73822c), which
  // caused a 32% CPU regression — the fallback became the primary path because
  // both bootstrap_pending and recent_connect ZSETs are typically empty after
  // hydration completes. Reverted: ZSET emptiness alone is NOT sufficient.
  const shouldRunConnectedFallback = CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK;

  let connectedFallbackCount = 0;
  if (shouldRunConnectedFallback) {
    const activeConnectedTargets = await resolveActiveConnectedChannelUserTargets(channelId, targetSet);
    connectedFallbackCount = activeConnectedTargets.length;
    for (const target of activeConnectedTargets) targetSet.add(target);
    if (connectedFallbackCount > 0) {
      wsFanoutRecoveryAsyncTotal?.inc?.({ reason: 'connected_fallback_fired' });
    }
  }
  const activeTargets = [...targetSet];
  const duplicateCandidateCount = recentTargets.length + connectedFallbackCount - activeTargets.length;
  if (duplicateCandidateCount > 0) {
    wsRecipientDuplicateCandidatesTotal?.inc?.(
      { path: 'channel_message_active_subscribers' },
      duplicateCandidateCount,
    );
    const wl = getWorkerLabels();
    wsDuplicateDeliverySuppressedTotal?.inc?.(
      {
        path: 'channel_message_active_subscribers',
        reason: 'duplicate_candidate',
        vm: wl.vm,
        worker: wl.worker,
      },
      duplicateCandidateCount,
    );
  }

  const activeTargetLookupMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_active_subscribers', stage: 'target_lookup' },
    activeTargetLookupMs,
  );
  const _wl = getWorkerLabels();
  wsTargetLookupDurationMs?.observe?.(
    { path: 'channel_message_active_subscribers', result: 'miss', vm: _wl.vm, worker: _wl.worker },
    activeTargetLookupMs,
  );
  fanoutTargetCandidatesHistogram.observe(
    { path: 'channel_message_active_subscribers' },
    activeTargets.length + 1,
  );
  wsFanoutCandidateCountBucket?.observe?.(
    { path: 'channel_message_active_subscribers' },
    activeTargets.length + 1,
  );
  wsActiveSubscriberTargetsBucket?.observe?.(
    { path: 'channel_message_active_subscribers' },
    activeTargets.length,
  );
  if (activeTargets.length > 0) {
    wsFanoutActiveTargetHitTotal?.inc?.(
      { path: 'channel_message_active_subscribers' },
      activeTargets.length,
    );
  } else {
    wsFanoutActiveTargetMissTotal?.inc?.({ path: 'channel_message_active_subscribers' });
  }
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'total' },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );

  return {
    allTargets: activeTargets,
    recentTargets: activeTargets,
    candidateCount: recentCandidateTargets.length + connectedFallbackCount + 1,
    cacheResult: 'miss' as const,
    pendingEnqueueTargets: Array.from(new Set([...recentCandidateTargets, ...activeTargets])),
  };
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
  if (isChannelMessageLiveEvent(envelope) && mode !== 'all') {
    return resolveActiveChannelMessageTargets(channelId);
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
  const userTopicLookupMs = Number(process.hrtime.bigint() - lookupStartedAt) / 1e6;
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'target_lookup' },
    userTopicLookupMs,
  );
  const _wl2 = getWorkerLabels();
  wsTargetLookupDurationMs?.observe?.(
    { path: 'channel_message_user_topics', result: targetLookup.cacheResult, vm: _wl2.vm, worker: _wl2.worker },
    userTopicLookupMs,
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

  const candidateTargets = await resolveRecentChannelUserTargetsRaw(
    channelId,
    CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX,
  );
  const targets = await filterActiveConnectedUserTargets(
    candidateTargets,
    'channel_message_immediate_recent_bridge_user_topics',
  );
  if (!targets.length) {
    return { targetCount: 0 };
  }

  enqueuePendingMessageForUsers(candidateTargets, envelope, { recentTargets: targets }).catch((err) => {
    logger.warn(
      { err, channelId, targetCount: candidateTargets.length },
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

  if (envelope?.event === 'message:created' && pendingEnqueueTargets.length > 0) {
    // Fire-and-forget: runs concurrently with channel publish and community feed.
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

  await publishCommunityFeedIfPublic();

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
