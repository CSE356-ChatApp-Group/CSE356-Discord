import type { Entity } from './chatStoreTypes';

export function channelCommunityId(channel: Entity) {
  return channel?.community_id || channel?.communityId || null;
}

export function normalizeCommunityId(input: any): string {
  const id = String(
    input?.id
      ?? input?.communityId
      ?? input?.community_id
      ?? input?.community?.id
      ?? input?.community?.communityId
      ?? input?.community?.community_id
      ?? input?.data?.id
      ?? '',
  ).trim();
  return id;
}

export function requireCommunityId(id: string | null | undefined, action: string): string {
  const normalized = String(id ?? '').trim();
  if (!normalized) {
    throw new Error(`${action} requires a valid community id`);
  }
  return normalized;
}

export function canAccessChannel(channel: Entity | null | undefined) {
  return Boolean(channel && (channel?.can_access ?? channel?.canAccess ?? !channel?.is_private));
}

export function upsertChannel(channels: Entity[], incoming: Entity) {
  if (!incoming?.id) return channels || [];
  const list = Array.isArray(channels) ? channels : [];
  const index = list.findIndex((channel) => channel.id === incoming.id);
  if (index === -1) return [...list, incoming];

  const next = [...list];
  next[index] = { ...next[index], ...incoming };
  return next;
}

export function preserveRecentLocalChannels(
  serverChannels: Entity[],
  existingChannels: Entity[],
  communityId: string,
) {
  const merged = Array.isArray(serverChannels) ? [...serverChannels] : [];
  const seen = new Set(merged.map((channel) => channel?.id).filter(Boolean));
  const now = Date.now();

  for (const channel of Array.isArray(existingChannels) ? existingChannels : []) {
    if (!channel?.id || seen.has(channel.id)) continue;
    if (channelCommunityId(channel) !== communityId) continue;
    const localCreatedAt = Number(channel._localCreatedAt || 0);
    if (!localCreatedAt || now - localCreatedAt > 15_000) continue;
    merged.push(channel);
    seen.add(channel.id);
  }

  return merged;
}
