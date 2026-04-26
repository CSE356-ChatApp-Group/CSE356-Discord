/**
 * When PG reconcile is disabled, delete-time repoint must not hit the database.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  pipeline: jest.fn(() => ({ exec: jest.fn(async () => []) })),
  hset: jest.fn(),
  sadd: jest.fn(),
  smembers: jest.fn(async () => []),
  srem: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), debug: jest.fn() })),
}));

jest.mock('../src/utils/metrics', () => ({
  messageLastMessageRepointFkRetryTotal: { inc: jest.fn() },
  channelLastMessageUpdateDeferredTotal: { inc: jest.fn() },
  channelLastMessageUpdateFlushedTotal: { inc: jest.fn() },
  channelLastMessageUpdateFailedTotal: { inc: jest.fn() },
  lastMessageRedisUpdateTotal: { inc: jest.fn() },
  lastMessagePgReconcileTotal: { inc: jest.fn() },
  lastMessagePgReconcileSkippedTotal: { inc: jest.fn() },
  lastMessageCacheTotal: { inc: jest.fn() },
}));

jest.mock('../src/messages/sideEffects', () => ({
  enqueueFanoutJob: jest.fn((_name: string, fn: () => Promise<void>) => fn()),
}));

jest.mock('../src/messages/messageInsertLockPressure', () => ({
  getShouldDeferReadReceiptForInsertLockPressure: jest.fn(() => false),
}));

process.env.LAST_MESSAGE_PG_RECONCILE_ENABLED = 'false';
process.env.CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED = 'false';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lastMessagePgReconcileSkippedTotal } = require('../src/utils/metrics') as {
  lastMessagePgReconcileSkippedTotal: { inc: jest.Mock };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  repointChannelLastMessage,
  repointConversationLastMessage,
} = require('../src/messages/repointLastMessage') as {
  repointChannelLastMessage: (channelId: string) => Promise<void>;
  repointConversationLastMessage: (conversationId: string) => Promise<void>;
};

describe('repointLastMessage reconcile gate', () => {
  beforeEach(() => {
    (query as jest.Mock).mockReset();
    (lastMessagePgReconcileSkippedTotal.inc as jest.Mock).mockReset();
  });

  it('does not query Postgres for channel repoint when disabled', async () => {
    await repointChannelLastMessage('chan-1');
    expect(query).not.toHaveBeenCalled();
    expect(lastMessagePgReconcileSkippedTotal.inc).toHaveBeenCalledWith({
      reason: 'channel_repoint_disabled',
    });
  });

  it('does not query Postgres for conversation repoint when disabled', async () => {
    await repointConversationLastMessage('conv-1');
    expect(query).not.toHaveBeenCalled();
    expect(lastMessagePgReconcileSkippedTotal.inc).toHaveBeenCalledWith({
      reason: 'conversation_repoint_disabled',
    });
  });
});
