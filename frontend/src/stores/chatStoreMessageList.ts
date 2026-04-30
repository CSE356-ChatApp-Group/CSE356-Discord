import type { Entity } from './chatStoreTypes';

export function dedupeMessages(messages: Entity[]) {
  const deduped = [];
  const seen = new Set();

  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push(message);
  }

  return deduped;
}

/** Merge WS-hydrated rows with the latest GET page so opening a thread does not discard newer in-memory messages. */
export function mergeLatestPageWithExisting(local: Entity[] | undefined, server: Entity[]): Entity[] {
  const map = new Map<string, Entity>();
  for (const message of local || []) {
    if (message?.id) map.set(String(message.id), message);
  }
  for (const message of server || []) {
    if (!message?.id) continue;
    const id = String(message.id);
    const prev = map.get(id);
    map.set(id, prev ? { ...prev, ...message } : message);
  }
  return sortMessagesChronologically(Array.from(map.values()));
}

export function sortMessagesChronologically(messages: Entity[]): Entity[] {
  return [...messages].sort((a, b) => {
    const ta = new Date(a.created_at || a.createdAt || 0).getTime();
    const tb = new Date(b.created_at || b.createdAt || 0).getTime();
    const na = Number.isFinite(ta) ? ta : 0;
    const nb = Number.isFinite(tb) ? tb : 0;
    if (na !== nb) return na - nb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function messageSortKey(m: Entity): number {
  const t = new Date(m.created_at || m.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function compareMessageOrder(a: Entity, b: Entity): number {
  const na = messageSortKey(a);
  const nb = messageSortKey(b);
  if (na !== nb) return na - nb;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/** Upsert without full-array sort — hot path for WS + send ack (list stays chronologically sorted). */
export function upsertMessageChronologically(existing: Entity[] | undefined, incoming: Entity): Entity[] {
  const list = Array.isArray(existing) ? existing : [];
  const idx = list.findIndex((m) => m.id === incoming.id);
  if (idx !== -1) {
    const next = [...list];
    next[idx] = { ...next[idx], ...incoming };
    return next;
  }
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (compareMessageOrder(incoming, list[mid]) <= 0) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const next = [...list];
  next.splice(lo, 0, incoming);
  return next;
}
