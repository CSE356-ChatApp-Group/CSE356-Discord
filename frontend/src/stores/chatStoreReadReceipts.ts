/**
 * Coalesced client read-receipt PUTs (live tail batches rapid marks; navigation flushes).
 * Message list access is injected via bindReadReceiptMessageLookup to avoid importing the store.
 * Multi-target flushes (e.g. tab hidden) coalesce into PUT /messages/batch-read when more than one mark ships together.
 */

import { api } from '../lib/api';
import type { Entity } from './chatStoreTypes';

export type PendingReadMark = {
  messageId: string;
  createdAtMs: number;
};

const READ_COALESCE_MS = (() => {
  const raw = Number(import.meta.env.VITE_READ_COALESCE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 750;
  return Math.min(1000, Math.max(500, Math.floor(raw)));
})();

/** Align chunk size with API `READ_RECEIPT_BATCH_MAX` (default 50, max 100). */
const READ_RECEIPT_BATCH_MAX = (() => {
  const raw = Number(import.meta.env.VITE_READ_RECEIPT_BATCH_MAX);
  if (!Number.isFinite(raw) || raw < 1) return 50;
  return Math.min(100, Math.max(1, Math.floor(raw)));
})();

let getMessagesForThread: (threadId: string) => Entity[] | undefined = () => undefined;

export function bindReadReceiptMessageLookup(fn: typeof getMessagesForThread) {
  getMessagesForThread = fn;
}

const readMarkInFlight = new Set<string>();
const pendingReadByTarget = new Map<string, PendingReadMark>();
const readCoalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSentReadByTarget = new Map<string, PendingReadMark & { sentAt: number }>();
let readFlushVisibilityHooked = false;

function readTargetFromOptions(opts: { channelId?: string | null; conversationId?: string | null }) {
  if (opts.channelId != null && opts.channelId !== '') return `ch:${opts.channelId}`;
  if (opts.conversationId != null && opts.conversationId !== '') return `dm:${opts.conversationId}`;
  return null;
}

function readTargetId(target: string) {
  const idx = target.indexOf(':');
  return idx === -1 ? target : target.slice(idx + 1);
}

function findMessageInTarget(target: string, messageId: string) {
  const messages = getMessagesForThread(readTargetId(target)) || [];
  return messages.find((message) => message?.id === messageId) || null;
}

function readMarkCandidate(
  target: string,
  messageId: string,
  opts?: { messageCreatedAt?: string | Date | null },
): PendingReadMark {
  return {
    messageId,
    createdAtMs:
      parseMessageCreatedAtMs(opts?.messageCreatedAt)
      || messageCreatedAtMs(findMessageInTarget(target, messageId)),
  };
}

function parseMessageCreatedAtMs(value: unknown) {
  if (!value) return 0;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function messageCreatedAtMs(message?: Entity | null) {
  return parseMessageCreatedAtMs(message?.created_at || message?.createdAt);
}

function isReadMarkAdvance(next: PendingReadMark, prev?: PendingReadMark | null) {
  if (!prev) return true;
  if (next.messageId === prev.messageId) return false;
  if (next.createdAtMs > 0 && prev.createdAtMs > 0) {
    return next.createdAtMs > prev.createdAtMs;
  }
  return true;
}

function latestReadMark(a: PendingReadMark | undefined, b: PendingReadMark) {
  if (!a) return b;
  return isReadMarkAdvance(b, a) ? b : a;
}

function pruneLastSentReadMarks() {
  if (lastSentReadByTarget.size <= 500) return;
  const cutoff = Date.now() - 60_000;
  for (const [target, entry] of lastSentReadByTarget) {
    if (entry.sentAt < cutoff) lastSentReadByTarget.delete(target);
  }
}

function hookReadFlushOnVisibilityHidden() {
  if (readFlushVisibilityHooked || typeof document === 'undefined') return;
  readFlushVisibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAllPendingReadCoalesce();
    }
  });
}

type FlushItem = { target: string; readMark: PendingReadMark };

function clearReadCoalesceTimer(target: string) {
  const existingTimer = readCoalesceTimers.get(target);
  if (existingTimer) {
    clearTimeout(existingTimer);
    readCoalesceTimers.delete(target);
  }
}

function flushPendingReadForTarget(target: string) {
  clearReadCoalesceTimer(target);
  const readMark = pendingReadByTarget.get(target);
  if (!readMark) return;
  pendingReadByTarget.delete(target);
  emitReadsAfterFlush([{ target, readMark }]);
}

/**
 * After collecting pending marks, either one PUT /messages/:id/read or fewer PUT /messages/batch-read calls.
 */
function emitReadsAfterFlush(items: FlushItem[]) {
  const ready: FlushItem[] = [];
  for (const { target, readMark } of items) {
    if (!readMark?.messageId) continue;
    if (!isReadMarkAdvance(readMark, lastSentReadByTarget.get(target))) continue;
    if (readMarkInFlight.has(target)) {
      pendingReadByTarget.set(target, latestReadMark(pendingReadByTarget.get(target), readMark));
      if (!readCoalesceTimers.has(target)) {
        readCoalesceTimers.set(
          target,
          setTimeout(() => flushPendingReadForTarget(target), READ_COALESCE_MS),
        );
      }
      continue;
    }
    ready.push({ target, readMark });
  }
  if (!ready.length) return;

  if (ready.length === 1) {
    emitSingleReadPut(ready[0]);
    return;
  }

  const chunks: FlushItem[][] = [];
  for (let i = 0; i < ready.length; i += READ_RECEIPT_BATCH_MAX) {
    chunks.push(ready.slice(i, i + READ_RECEIPT_BATCH_MAX));
  }
  void emitBatchedReadPutsSequential(chunks);
}

async function emitBatchedReadPutsSequential(chunks: FlushItem[][]) {
  for (const chunk of chunks) {
    for (const { target } of chunk) readMarkInFlight.add(target);
    for (const { target, readMark } of chunk) {
      lastSentReadByTarget.set(target, { ...readMark, sentAt: Date.now() });
    }
    try {
      await api.put('/messages/batch-read', {
        reads: chunk.map((c) => c.readMark.messageId),
      });
    } catch {
      // Match legacy single-read fire-and-forget behavior on failure
    } finally {
      for (const { target } of chunk) {
        readMarkInFlight.delete(target);
        pruneLastSentReadMarks();
        if (pendingReadByTarget.has(target)) {
          flushPendingReadForTarget(target);
        }
      }
    }
  }
}

function emitSingleReadPut({ target, readMark }: FlushItem) {
  readMarkInFlight.add(target);
  lastSentReadByTarget.set(target, { ...readMark, sentAt: Date.now() });
  api.put(`/messages/${readMark.messageId}/read`)
    .catch(() => {})
    .finally(() => {
      readMarkInFlight.delete(target);
      pruneLastSentReadMarks();
      if (pendingReadByTarget.has(target)) {
        flushPendingReadForTarget(target);
      }
    });
}

export function flushAllPendingReadCoalesce() {
  const items: FlushItem[] = [];
  const targets = new Set([...pendingReadByTarget.keys(), ...readCoalesceTimers.keys()]);
  for (const target of targets) {
    clearReadCoalesceTimer(target);
    const readMark = pendingReadByTarget.get(target);
    if (!readMark) continue;
    pendingReadByTarget.delete(target);
    items.push({ target, readMark });
  }
  emitReadsAfterFlush(items);
}

/**
 * @param coalesce When true, batch rapid updates (live message stream). When false, flush immediately (navigation).
 */
export function queueMarkMessageRead(
  messageId: string | undefined | null,
  opts: {
    channelId?: string | null;
    conversationId?: string | null;
    coalesce?: boolean;
    messageCreatedAt?: string | Date | null;
  },
) {
  hookReadFlushOnVisibilityHidden();
  if (!messageId) return;
  const target = readTargetFromOptions(opts);
  if (!target) return;

  const candidate = readMarkCandidate(target, messageId, opts);
  if (!isReadMarkAdvance(candidate, lastSentReadByTarget.get(target))) return;
  const pending = pendingReadByTarget.get(target);
  if (pending && !isReadMarkAdvance(candidate, pending)) return;

  pendingReadByTarget.set(target, latestReadMark(pending, candidate));

  const existingTimer = readCoalesceTimers.get(target);
  if (existingTimer) clearTimeout(existingTimer);

  if (opts.coalesce) {
    readCoalesceTimers.set(
      target,
      setTimeout(() => flushPendingReadForTarget(target), READ_COALESCE_MS),
    );
  } else {
    flushPendingReadForTarget(target);
  }
}

export { flushPendingReadForTarget };

export function resetReadReceiptState() {
  readMarkInFlight.clear();
  lastSentReadByTarget.clear();
  for (const t of readCoalesceTimers.values()) {
    clearTimeout(t);
  }
  readCoalesceTimers.clear();
  pendingReadByTarget.clear();
}
