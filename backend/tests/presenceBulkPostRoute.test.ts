const userId = '00000000-0000-4000-8000-000000000001';

jest.mock('../src/presence/service', () => ({
  getBulkPresenceDetails: jest.fn(),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: userId };
    next();
  },
}));

const presence = require('../src/presence/service') as {
  getBulkPresenceDetails: jest.Mock;
};

function requestPresenceBulk(body: any) {
  const router = require('../src/presence/router');
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req: any = {
      method: 'POST',
      url: '/bulk',
      originalUrl: '/api/v1/presence/bulk',
      path: '/bulk',
      headers: {},
      body,
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        this.body = payload;
        resolve({ statusCode: this.statusCode, body: payload });
        return this;
      },
      setHeader: jest.fn(),
      getHeader: jest.fn(),
      end: jest.fn(),
    };
    router.handle(req, res, reject);
  });
}

describe('POST /presence/bulk', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns presence map for request user ids', async () => {
    presence.getBulkPresenceDetails.mockResolvedValue({
      'u-1': { status: 'online', awayMessage: null },
      'u-2': { status: 'away', awayMessage: 'Back soon' },
    });

    const res = await requestPresenceBulk({ userIds: ['u-1', 'u-2'] });
    expect(res.statusCode).toBe(200);
    expect(res.body.presence).toEqual({
      'u-1': 'online',
      'u-2': 'away',
    });
    expect(res.body.awayMessages).toEqual({
      'u-2': 'Back soon',
    });
    expect(presence.getBulkPresenceDetails).toHaveBeenCalledWith(['u-1', 'u-2']);
  });

  it('returns 400 for missing/empty userIds array', async () => {
    const missing = await requestPresenceBulk({});
    expect(missing.statusCode).toBe(400);
    const empty = await requestPresenceBulk({ userIds: [] });
    expect(empty.statusCode).toBe(400);
  });
});

