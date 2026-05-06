/**
 * When Redis `read_cursor_ts:*` is ahead of the message on CAS 0, the worker merges that
 * value into the in-process scope cache so `readReceiptScopeCursorCacheSaysNoAdvance`
 * can skip the read-receipt Lua on subsequent older messages (same process).
 */

import { randomUUID } from 'crypto';
import { redis } from './runtime';

const {
  rememberReadReceiptScopeCursorMergedWithRedis,
  readReceiptScopeCursorCacheSaysNoAdvance,
} = require('../src/messages/lib/readReceiptState');

describe('read receipt scope cache merged with Redis cursor', () => {
  it('raises in-process cursor to max(messageTs, read_cursor_ts) on CAS-0 merge', async () => {
    const userId = randomUUID();
    const channelId = randomUUID();
    const cursorKey = `read_cursor_ts:${userId}:ch:${channelId}`;
    await redis.set(cursorKey, '5000', 'EX', 60);
    await rememberReadReceiptScopeCursorMergedWithRedis({
      userId,
      channelId,
      conversationId: null,
      messageCreatedAt: new Date(1000).toISOString(),
      messageTsMs: 1000,
    });
    const noAdvance = readReceiptScopeCursorCacheSaysNoAdvance({
      userId,
      channelId,
      conversationId: null,
      messageCreatedAt: new Date(2000).toISOString(),
      messageTsMs: 2000,
    });
    expect(noAdvance).toBe(true);
    await redis.del(cursorKey);
  });
});
