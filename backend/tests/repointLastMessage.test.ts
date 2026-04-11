/**
 * Unit tests for last_message repoint under concurrent-delete FK races (23503).
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), debug: jest.fn() })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { messageLastMessageRepointFkRetryTotal } = require('../src/utils/metrics') as {
  messageLastMessageRepointFkRetryTotal: { inc: jest.Mock };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  repointChannelLastMessage,
  repointConversationLastMessage,
} = require('../src/messages/repointLastMessage') as {
  repointChannelLastMessage: (channelId: string) => Promise<void>;
  repointConversationLastMessage: (conversationId: string) => Promise<void>;
};

const fkErr = Object.assign(new Error('fk'), { code: '23503', detail: 'channels_last_message_id_fkey' });

describe('repointLastMessage', () => {
  const mockedQuery = query as jest.MockedFunction<typeof query>;

  beforeEach(() => {
    mockedQuery.mockReset();
    jest.clearAllMocks();
  });

  it('repointChannelLastMessage succeeds when the first UPDATE matches a row', async () => {
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await repointChannelLastMessage('chan-1');

    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('repointChannelLastMessage clears pointers when no messages remain', async () => {
    mockedQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await repointChannelLastMessage('chan-1');

    expect(mockedQuery).toHaveBeenCalledTimes(2);
    const clearSql = String(mockedQuery.mock.calls[1][0]);
    expect(clearSql).toContain('last_message_id = NULL');
  });

  it('repointChannelLastMessage retries after 23503 and increments metric', async () => {
    const incSpy = jest.spyOn(messageLastMessageRepointFkRetryTotal, 'inc');
    mockedQuery.mockRejectedValueOnce(fkErr);
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await repointChannelLastMessage('chan-1');

    expect(incSpy).toHaveBeenCalledWith({ scope: 'channel' });
    expect(mockedQuery).toHaveBeenCalledTimes(3);
    incSpy.mockRestore();
  });

  it('repointChannelLastMessage rethrows after repeated 23503', async () => {
    mockedQuery.mockRejectedValueOnce(fkErr);
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mockedQuery.mockRejectedValueOnce(fkErr);
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mockedQuery.mockRejectedValueOnce(fkErr);
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mockedQuery.mockRejectedValueOnce(fkErr);

    await expect(repointChannelLastMessage('chan-1')).rejects.toMatchObject({ code: '23503' });
    expect(mockedQuery).toHaveBeenCalledTimes(7);
  });

  it('repointConversationLastMessage retries after 23503 and increments metric', async () => {
    const incSpy = jest.spyOn(messageLastMessageRepointFkRetryTotal, 'inc');
    mockedQuery.mockRejectedValueOnce(fkErr);
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await repointConversationLastMessage('conv-1');

    expect(incSpy).toHaveBeenCalledWith({ scope: 'conversation' });
    incSpy.mockRestore();
  });
});
