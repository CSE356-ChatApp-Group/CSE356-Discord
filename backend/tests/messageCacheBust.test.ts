/**
 * Message list cache bust: pipeline DEL+INCR ordering and metrics.
 */

const {
  bustChannelMessagesCache,
  bustConversationMessagesCache,
  channelMsgCacheKey,
  channelMsgCacheEpochKey,
  conversationMsgCacheKey,
  conversationMsgCacheEpochKey,
} = require('../src/messages/messageCacheBust');

const client = require('prom-client');
const { messageCacheBustWallDurationMs } = require('../src/utils/metrics');

describe('messageCacheBust', () => {
  beforeEach(() => {
    messageCacheBustWallDurationMs.reset();
  });

  it('uses a single pipeline with DEL then INCR for channel bust', async () => {
    const cmds: string[] = [];
    const listKey = channelMsgCacheKey('ch-1');
    const epochKey = channelMsgCacheEpochKey('ch-1');
    const redis = {
      get: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      pipeline() {
        return {
          del(k: string) {
            cmds.push(`del:${k}`);
            return this;
          },
          incr(k: string) {
            cmds.push(`incr:${k}`);
            return this;
          },
          exec: async () => [
            [null, 1],
            [null, 2],
          ],
        };
      },
    };
    await bustChannelMessagesCache(redis as any, 'ch-1');
    expect(cmds).toEqual([`del:${listKey}`, `incr:${epochKey}`]);
  });

  it('uses pipeline DEL then INCR for conversation bust', async () => {
    const cmds: string[] = [];
    const listKey = conversationMsgCacheKey('cv-1');
    const epochKey = conversationMsgCacheEpochKey('cv-1');
    const redis = {
      get: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      pipeline() {
        return {
          del(k: string) {
            cmds.push(`del:${k}`);
            return this;
          },
          incr(k: string) {
            cmds.push(`incr:${k}`);
            return this;
          },
          exec: async () => [
            [null, 1],
            [null, 3],
          ],
        };
      },
    };
    await bustConversationMessagesCache(redis as any, 'cv-1');
    expect(cmds).toEqual([`del:${listKey}`, `incr:${epochKey}`]);
  });

  it('falls back to sequential del then incr when pipeline is missing', async () => {
    const calls: string[] = [];
    const redis = {
      get: jest.fn(),
      del: jest.fn(async (k: string) => {
        calls.push(`del:${k}`);
      }),
      incr: jest.fn(async (k: string) => {
        calls.push(`incr:${k}`);
      }),
    };
    await bustChannelMessagesCache(redis as any, 'ch-2');
    expect(calls[0]).toMatch(/^del:messages:channel:ch-2$/);
    expect(calls[1]).toMatch(/^incr:messages:channel:ch-2:cacheEpoch$/);
  });

  it('observes wall duration histogram on pipeline path', async () => {
    const redis = {
      get: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      pipeline() {
        return {
          del() {
            return this;
          },
          incr() {
            return this;
          },
          exec: async () => [
            [null, 1],
            [null, 1],
          ],
        };
      },
    };
    await bustChannelMessagesCache(redis as any, 'ch-metric');
    const payload = await client.register.getMetricsAsJSON();
    const found = payload.find(
      (m: { name: string }) => m.name === 'message_cache_bust_wall_duration_ms'
    );
    expect(found).toBeDefined();
    expect(
      (found as { values: Array<{ labels: { scope: string }; value: number }> }).values.some(
        (v) => v.labels.scope === 'channel' && v.value >= 1
      )
    ).toBe(true);
  });

  it('still completes without throwing when exec rejects', async () => {
    const redis = {
      get: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      pipeline() {
        return {
          del() {
            return this;
          },
          incr() {
            return this;
          },
          exec: async () => {
            throw new Error('redis down');
          },
        };
      },
    };
    await expect(bustChannelMessagesCache(redis as any, 'ch-err')).resolves.toBeUndefined();
  });
});
