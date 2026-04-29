'use strict';

const fanout = require('./fanout');

const rawCommunityFeedShardCount = Number(process.env.COMMUNITY_FEED_SHARD_COUNT || '64');
const COMMUNITY_FEED_SHARD_COUNT =
  Number.isFinite(rawCommunityFeedShardCount) && rawCommunityFeedShardCount > 0
    ? Math.max(1, Math.min(256, Math.floor(rawCommunityFeedShardCount)))
    : 64;

function normalizeCommunityId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function communityFeedShardForCommunityId(communityId: string): number {
  const normalized = normalizeCommunityId(communityId) || '';
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % COMMUNITY_FEED_SHARD_COUNT;
}

function communityFeedRedisChannelForCommunityId(communityId: string): string {
  return `communityfeed:${communityFeedShardForCommunityId(communityId)}`;
}

function allCommunityFeedRedisChannels(): string[] {
  return Array.from(
    { length: COMMUNITY_FEED_SHARD_COUNT },
    (_unused, shardIndex) => `communityfeed:${shardIndex}`,
  );
}

function communityFeedEnvelope(communityId: string, payload: unknown) {
  return {
    __wsRoute: {
      kind: 'community',
      communityId,
    },
    payload,
  };
}

async function publishCommunityFeedMessage(communityId: string, payload: unknown): Promise<void> {
  const normalized = normalizeCommunityId(communityId);
  if (!normalized) return;
  await fanout.publish(
    communityFeedRedisChannelForCommunityId(normalized),
    communityFeedEnvelope(normalized, payload),
  );
}

function isCommunityFeedEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = (value as { __wsRoute?: unknown }).__wsRoute;
  if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
  return (
    (route as { kind?: unknown }).kind === 'community'
    && typeof (route as { communityId?: unknown }).communityId === 'string'
    && !!(value as { payload?: unknown }).payload
    && typeof (value as { payload?: unknown }).payload === 'object'
    && !Array.isArray((value as { payload?: unknown }).payload)
  );
}

module.exports = {
  COMMUNITY_FEED_SHARD_COUNT,
  allCommunityFeedRedisChannels,
  communityFeedRedisChannelForCommunityId,
  publishCommunityFeedMessage,
  isCommunityFeedEnvelope,
};
