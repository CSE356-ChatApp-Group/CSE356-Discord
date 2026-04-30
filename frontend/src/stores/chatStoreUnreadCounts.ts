import { api } from '../lib/api';
import type { UnreadCountsSnapshot } from './chatStoreTypes';

let unreadCountsInFlight: Promise<UnreadCountsSnapshot> | null = null;
let unreadCountsCache: { at: number; value: UnreadCountsSnapshot } | null = null;
const UNREAD_COUNTS_CACHE_TTL_MS = 2000;

function emptyUnreadCountsSnapshot(): UnreadCountsSnapshot {
  return {
    channelCounts: new Map<string, number>(),
    conversationCounts: new Map<string, number>(),
  };
}

export async function fetchUnreadCountsSnapshot(force = false): Promise<UnreadCountsSnapshot> {
  const now = Date.now();
  if (!force && unreadCountsCache && now - unreadCountsCache.at <= UNREAD_COUNTS_CACHE_TTL_MS) {
    return unreadCountsCache.value;
  }
  if (unreadCountsInFlight) return unreadCountsInFlight;

  unreadCountsInFlight = (async () => {
    try {
      const payload = await api.get('/unread-counts');
      const rows = payload?.unreadCounts || payload?.counts || payload?.data || [];
      const snapshot = emptyUnreadCountsSnapshot();
      for (const row of Array.isArray(rows) ? rows : []) {
        const type = row?.type === 'conversation' ? 'conversation' : 'channel';
        const count = Math.max(0, Number(row?.count || 0));
        if (type === 'channel') {
          const id = String(row?.channel_id || row?.channelId || row?.conversation_id || row?.conversationId || '');
          if (id) snapshot.channelCounts.set(id, count);
          continue;
        }
        const id = String(row?.conversation_id || row?.conversationId || '');
        if (id) snapshot.conversationCounts.set(id, count);
      }
      unreadCountsCache = { at: Date.now(), value: snapshot };
      return snapshot;
    } catch {
      const fallback = emptyUnreadCountsSnapshot();
      unreadCountsCache = { at: Date.now(), value: fallback };
      return fallback;
    } finally {
      unreadCountsInFlight = null;
    }
  })();

  return unreadCountsInFlight;
}
