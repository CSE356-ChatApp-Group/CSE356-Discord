import express from 'express';
import request from 'supertest';

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

jest.mock('../src/auth/passwords', () => ({
  hashPassword: jest.fn(),
}));

jest.mock('../src/presence/service', () => ({
  getPresenceDetails: jest.fn().mockResolvedValue({ status: 'online', awayMessage: null }),
  getPresence: jest.fn().mockResolvedValue('online'),
  setPresence: jest.fn(),
  setAwayMessage: jest.fn(),
  syncConnectionStatuses: jest.fn(),
}));

jest.mock('../src/attachments/storage', () => ({
  BUCKET: 'test-bucket',
  s3: { send: jest.fn() },
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../src/communities/membersRoster', () => ({
  invalidateCommunityMemberRostersForUser: jest.fn().mockResolvedValue(undefined),
}));

const pool = require('../src/db/pool') as {
  query: jest.Mock;
};
const {
  invalidateCommunityMemberRostersForUser,
} = require('../src/communities/membersRoster') as {
  invalidateCommunityMemberRostersForUser: jest.Mock;
};

function buildApp() {
  const router = require('../src/auth/usersRouter');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', router);
  return app;
}

describe('user profile updates invalidate community member roster caches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invalidates member rosters when displayName changes', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          username: 'alice',
          display_name: 'Alice Updated',
          avatar_url: null,
          bio: null,
          created_at: '2026-01-01T00:00:00.000Z',
          last_seen_at: '2026-01-01T00:00:00.000Z',
          email: 'alice@example.com',
        },
      ],
    });

    const app = buildApp();
    const res = await request(app)
      .patch('/api/v1/users/me')
      .send({ displayName: 'Alice Updated' });

    expect(res.status).toBe(200);
    expect(invalidateCommunityMemberRostersForUser).toHaveBeenCalledWith('user-1');
    expect(res.body.user.display_name).toBe('Alice Updated');
  });
});
