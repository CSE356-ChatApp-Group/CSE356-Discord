jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadAttachmentForUser } = require('../src/attachments/accessCache') as {
  loadAttachmentForUser: (attachmentId: string, userId: string) => Promise<any>;
};

describe('attachment access cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  it('returns cached allowed attachment when version matches', async () => {
    redis.get
      .mockResolvedValueOnce(JSON.stringify({
        found: true,
        allowed: true,
        attachment: { id: 'a1', channel_id: 'ch1', storage_key: 'k' },
        scope: { kind: 'channel', id: 'ch1' },
        version: 2,
      }))
      .mockResolvedValueOnce('2');

    const result = await loadAttachmentForUser('a1', 'u1');
    expect(result.found).toBe(true);
    expect(result.allowed).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('invalidates stale cached attachment access and reloads from DB', async () => {
    redis.get
      .mockResolvedValueOnce(JSON.stringify({
        found: true,
        allowed: true,
        attachment: { id: 'a2', conversation_id: 'cv1', storage_key: 'k' },
        scope: { kind: 'conversation', id: 'cv1' },
        version: 1,
      }))
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce('2');
    query.mockResolvedValueOnce({
      rows: [{
        id: 'a2',
        channel_id: null,
        conversation_id: 'cv1',
        storage_key: 'k',
        has_access: false,
      }],
    });

    const result = await loadAttachmentForUser('a2', 'u2');
    expect(redis.del).toHaveBeenCalledWith('attachment:get:a2:u2');
    expect(query).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(result.allowed).toBe(false);
  });
});
