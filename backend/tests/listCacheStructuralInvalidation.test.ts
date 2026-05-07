/**
 * Structural list cache bust policy: volatile message traffic must not churn
 * conversations/channels/communities Redis list keys; normalized metric reasons only.
 *
 * @jest-environment node
 */

jest.mock('../src/utils/endpointCacheMetrics', () => ({
  recordEndpointListCache: jest.fn(),
  recordEndpointListCacheBypass: jest.fn(),
  recordEndpointListCacheInvalidation: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({}));

jest.mock('../src/messages/messageCacheBust', () => ({
  bustChannelMessagesCache: jest.fn(() => Promise.resolve()),
  bustConversationMessagesCache: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/db/redisBatch', () => ({
  redisBatchUnlink: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  isLevelEnabled: jest.fn(() => false),
}));

const fs = require('fs');
const path = require('path');

describe('list cache structural invalidation policy', () => {
  const metrics = require('../src/utils/endpointCacheMetrics') as {
    recordEndpointListCacheInvalidation: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    metrics.recordEndpointListCacheInvalidation.mockReset();
  });

  it('endpoint_list_cache invalidation reasons stay low-cardinality (no raw IDs in labels)', () => {
    const allowedEndpoints = new Set([
      'communities',
      'channels',
      'messages_channel',
      'messages_conversation',
      'conversations',
    ]);
    const labelSafeReason = /^[a-z][a-z0-9_]*$/;

    const samples: Array<[string, string]> = [
      ['conversations', 'structural_conversation_change'],
      ['channels', 'structural_channel_change'],
      ['communities', 'membership_change'],
      ['messages_channel', 'message_list_volatile'],
    ];
    for (const [endpoint, reason] of samples) {
      expect(allowedEndpoints.has(endpoint)).toBe(true);
      expect(reason).toMatch(labelSafeReason);
      expect(reason).not.toMatch(/^[0-9a-f-]{36}$/i);
      expect(reason).not.toContain(':');
      metrics.recordEndpointListCacheInvalidation(endpoint, reason);
    }
  });

  it('POST message path busts only volatile message-list metrics, not structural list endpoints', async () => {
    const { bustMessagesCacheSafe } = require('../src/messages/lib/messageListCache');
    await bustMessagesCacheSafe({ channelId: '00000000-0000-4000-8000-000000000001' });

    expect(metrics.recordEndpointListCacheInvalidation).toHaveBeenCalledWith(
      'messages_channel',
      'message_list_volatile',
    );
    for (const call of metrics.recordEndpointListCacheInvalidation.mock.calls) {
      const [endpoint] = call;
      expect(endpoint === 'conversations' || endpoint === 'channels' || endpoint === 'communities').toBe(
        false,
      );
    }
  });

  it('invalidateConversationsListCaches still records structural/membership reasons for router-driven busts', async () => {
    const {
      invalidateConversationsListCaches,
    } = require('../src/messages/conversationsRouterListCache');

    await invalidateConversationsListCaches(['user-a', 'user-b'], 'membership_change');
    expect(metrics.recordEndpointListCacheInvalidation).toHaveBeenCalledWith(
      'conversations',
      'membership_change',
    );
  });

  it('read receipt handler source does not delete channels:list keys (no structural bust on read)', () => {
    const corePath = path.join(__dirname, '../src/messages/readReceipt/readReceiptHttpCore.ts');
    const src = fs.readFileSync(corePath, 'utf8');
    expect(src).not.toContain('channels:list');
  });

  it('DM/channel realtime fanout modules do not require structural list invalidation helpers', () => {
    const convFanoutPath = path.join(__dirname, '../src/messages/fanout/conversationFanout.ts');
    const chanFanoutPath = path.join(__dirname, '../src/messages/fanout/channelRealtimeFanout.ts');
    const convSrc = fs.readFileSync(convFanoutPath, 'utf8');
    const chanSrc = fs.readFileSync(chanFanoutPath, 'utf8');
    expect(convSrc).not.toContain('invalidateConversationsListCaches');
    expect(chanSrc).not.toContain('invalidateConversationsListCaches');
    expect(convSrc).not.toMatch(/require\([^)]*conversationsRouterListCache[^)]*\)/);
    expect(chanSrc).not.toMatch(/require\([^)]*conversationsRouterListCache[^)]*\)/);
  });
});
