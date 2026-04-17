jest.mock('../src/db/pool', () => ({
  withTransaction: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() })),
}));

jest.mock('../src/utils/overload', () => ({
  getStage: jest.fn(() => 0),
}));

const { withTransaction } = require('../src/db/pool') as { withTransaction: jest.Mock };
const overload = require('../src/utils/overload') as { getStage: jest.Mock };
const { search } = require('../src/search/client') as {
  search: (q: string, opts?: Record<string, any>) => Promise<{ hits: any[] }>;
};

describe('search overload behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overload.getStage.mockReturnValue(0);
  });

  it('skips trigram fallback for community-scoped searches at stage 1', async () => {
    overload.getStage.mockReturnValue(1);

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [] }),
      };
      recordedClient = client;
      return run(client);
    });

    const result = await search('hel', {
      communityId: 'community-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toEqual([]);
    expect(recordedClient?.query).toHaveBeenCalledTimes(2);
    expect(recordedClient?.query).toHaveBeenNthCalledWith(1, 'SET LOCAL statement_timeout = 3000');
  });

  it('still allows trigram fallback for channel-scoped searches at stage 1', async () => {
    overload.getStage.mockReturnValue(1);

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({
            rows: [{
              id: 'msg-1',
              content: 'hello there',
              authorId: 'user-1',
              authorDisplayName: 'User One',
              channelId: 'channel-1',
              conversationId: null,
              communityId: 'community-1',
              channelName: 'general',
              createdAt: '2026-04-17T18:35:23.000Z',
              highlight: 'hello there',
            }],
          }),
      };
      recordedClient = client;
      return run(client);
    });

    const result = await search('hel', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe('msg-1');
    expect(recordedClient?.query).toHaveBeenCalledTimes(3);
  });
});
