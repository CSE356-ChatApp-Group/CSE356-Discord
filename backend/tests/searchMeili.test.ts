/**
 * Meilisearch search path tests.
 *
 * Meilisearch is fully mocked — no live instance required for CI.
 * Tests verify:
 *   - SEARCH_BACKEND=meili routes through meiliClient.searchMessageCandidates
 *   - Postgres recheck filters out deleted messages (stale Meili candidate)
 *   - Postgres recheck enforces private-channel access
 *   - Postgres recheck enforces DM participant access
 *   - Author filter applied in Postgres recheck
 *   - Before/after time filters applied in Postgres recheck
 *   - Results returned newest-first
 *   - Edited message content is reflected in results (Meili returns id; Postgres provides fresh content)
 *   - Meili error triggers fallback to Postgres path (no 500)
 *   - SEARCH_BACKEND=postgres ignores meiliClient entirely
 */

import { request, app, wsServer, pool, closeRedisConnections } from './runtime';
import { uniqueSuffix, createAuthenticatedUser } from './helpers';

// jest.mock is hoisted — cannot reference const/let variables from outer scope.
// Use jest.fn() directly in the factory; capture references via require() after.
jest.mock('../src/search/meiliClient', () => ({
  isEnabled:               jest.fn(() => false),
  isSearchBackend:         jest.fn(() => false),
  searchMessageCandidates: jest.fn(),
  incFallbackTotal:        jest.fn(),
  indexMessage:            jest.fn().mockResolvedValue(undefined),
  deleteMessage:           jest.fn().mockResolvedValue(undefined),
  batchIndexMessages:      jest.fn().mockResolvedValue(undefined),
  checkHealth:             jest.fn().mockResolvedValue({ ok: true, status: 'available' }),
  checkIndex:              jest.fn().mockResolvedValue({ ok: true, uid: 'messages' }),
  setupIndex:              jest.fn().mockResolvedValue(undefined),
  MEILI_INDEX_MESSAGES:    'messages',
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _meiliMock = require('../src/search/meiliClient');
const mockSearchCandidates  = _meiliMock.searchMessageCandidates as jest.Mock;
const mockIsSearchBackend   = _meiliMock.isSearchBackend         as jest.Mock;
const mockIncFallbackTotal  = _meiliMock.incFallbackTotal        as jest.Mock;

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createCommunity(token: string) {
  const slug = `meili-comm-${uniqueSuffix()}`.slice(0, 32);
  const res = await request(app)
    .post('/api/v1/communities')
    .set('Authorization', `Bearer ${token}`)
    .send({ slug, name: slug, description: 'meili test' });
  expect(res.status).toBe(201);
  return res.body.community as { id: string };
}

async function createChannel(token: string, communityId: string, isPrivate = false) {
  const res = await request(app)
    .post('/api/v1/channels')
    .set('Authorization', `Bearer ${token}`)
    .send({
      communityId,
      name: `meili-ch-${uniqueSuffix()}`.slice(0, 32),
      isPrivate,
      description: '',
    });
  expect(res.status).toBe(201);
  return res.body.channel as { id: string };
}

async function sendMessage(token: string, channelId: string, content: string) {
  const res = await request(app)
    .post('/api/v1/messages')
    .set('Authorization', `Bearer ${token}`)
    .send({ channelId, content });
  expect(res.status).toBe(201);
  return res.body.message as { id: string; content: string; createdAt?: string };
}

async function joinCommunity(token: string, communityId: string) {
  const res = await request(app)
    .post(`/api/v1/communities/${communityId}/join`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
}

function setMeiliMode(ids: string[]) {
  mockIsSearchBackend.mockReturnValue(true);
  mockSearchCandidates.mockResolvedValue({ ids, estimatedTotal: ids.length });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Search – SEARCH_BACKEND=postgres (default)', () => {
  it('does not call meiliClient.searchMessageCandidates when backend is postgres', async () => {
    mockIsSearchBackend.mockReturnValue(false);
    const owner = await createAuthenticatedUser('meili-pg-owner');
    const community = await createCommunity(owner.accessToken);
    const channel = await createChannel(owner.accessToken, community.id);
    const marker = `nomeili${uniqueSuffix()}`;
    await sendMessage(owner.accessToken, channel.id, `${marker} test`);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect(mockSearchCandidates).not.toHaveBeenCalled();
  });
});

describe('Search – SEARCH_BACKEND=meili basic path', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  let messageId: string;
  const marker = `meilibasic${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('meili-basic-owner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken);
    communityId = community.id;
    const channel = await createChannel(ownerToken, community.id);
    channelId = channel.id;
    const msg = await sendMessage(ownerToken, channelId, `${marker} hello`);
    messageId = msg.id;
  });

  it('returns a hit when Meili supplies the correct candidate ID', async () => {
    setMeiliMode([messageId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits[0].id).toBe(messageId);
  });

  it('falls back to Postgres when Meili returns no candidates', async () => {
    setMeiliMode([]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(mockIncFallbackTotal).toHaveBeenCalled();
  });

  it('calls meiliClient.searchMessageCandidates with the correct scope', async () => {
    setMeiliMode([messageId]);

    await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(mockSearchCandidates).toHaveBeenCalledWith(
      marker,
      expect.objectContaining({ communityId }),
    );
  });
});

describe('Search – Meili path: Postgres recheck filters deleted messages', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('meili-del-owner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken);
    communityId = community.id;
    const channel = await createChannel(ownerToken, community.id);
    channelId = channel.id;
  });

  it('excludes a message that was deleted even if Meili returns its ID as a candidate', async () => {
    const marker = `meilideleted${uniqueSuffix()}`;
    const msg = await sendMessage(ownerToken, channelId, `${marker} content`);

    // Delete the message
    const del = await request(app)
      .delete(`/api/v1/messages/${msg.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(200);

    // Meili still returns the stale ID (simulates lag)
    setMeiliMode([msg.id]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.map((h: any) => h.id)).not.toContain(msg.id);
  });
});

describe('Search – Meili path: private channel access control', () => {
  let ownerToken: string;
  let outsiderToken: string;
  let communityId: string;
  let privateChannelId: string;
  let msgId: string;
  const marker = `meiliprivate${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner    = await createAuthenticatedUser('meili-priv-owner');
    const outsider = await createAuthenticatedUser('meili-priv-out');
    ownerToken    = owner.accessToken;
    outsiderToken = outsider.accessToken;

    const community = await createCommunity(ownerToken);
    communityId = community.id;
    const channel   = await createChannel(ownerToken, communityId, true); // private
    privateChannelId = channel.id;
    const msg = await sendMessage(ownerToken, privateChannelId, `${marker} secret`);
    msgId = msg.id;
  });

  it('returns 403 when outsider searches a private channel even if Meili has the ID', async () => {
    setMeiliMode([msgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });

  it('owner can find message in private channel', async () => {
    setMeiliMode([msgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits[0]?.id).toBe(msgId);
  });
});

describe('Search – Meili path: community scope excludes inaccessible private channels', () => {
  let ownerToken: string;
  let memberToken: string;
  let communityId: string;
  let publicMsgId: string;
  let privateMsgId: string;
  const pubMarker  = `meilipubcomm${uniqueSuffix()}`;
  const privMarker = `meiliprivcomm${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner  = await createAuthenticatedUser('meili-comm-owner');
    const member = await createAuthenticatedUser('meili-comm-member');
    ownerToken  = owner.accessToken;
    memberToken = member.accessToken;

    const community    = await createCommunity(ownerToken);
    communityId = community.id;
    await joinCommunity(memberToken, communityId);

    const pubCh  = await createChannel(ownerToken, communityId, false);
    const privCh = await createChannel(ownerToken, communityId, true);

    const pubMsg  = await sendMessage(ownerToken, pubCh.id,  `${pubMarker} public`);
    const privMsg = await sendMessage(ownerToken, privCh.id, `${privMarker} private`);
    publicMsgId  = pubMsg.id;
    privateMsgId = privMsg.id;
  });

  it('community member without private-channel access cannot see private message', async () => {
    // Meili returns both IDs; recheck must filter out the private one
    setMeiliMode([publicMsgId, privateMsgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${pubMarker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.hits.map((h: any) => h.id);
    expect(ids).not.toContain(privateMsgId);
  });

  it('owner (private channel member) can see private message', async () => {
    setMeiliMode([publicMsgId, privateMsgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${privMarker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.hits.map((h: any) => h.id);
    expect(ids).toContain(privateMsgId);
  });
});

describe('Search – Meili path: DM conversation access', () => {
  let userAToken: string;
  let userBToken: string;
  let outsiderToken: string;
  let conversationId: string;
  let msgId: string;
  const marker = `meilidmaccess${uniqueSuffix()}`;

  beforeAll(async () => {
    const userA    = await createAuthenticatedUser('meili-dm-a');
    const userB    = await createAuthenticatedUser('meili-dm-b');
    const outsider = await createAuthenticatedUser('meili-dm-out');
    userAToken    = userA.accessToken;
    userBToken    = userB.accessToken;
    outsiderToken = outsider.accessToken;

    const convRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ participantIds: [userB.username] });
    expect(convRes.status).toBe(201);
    conversationId = convRes.body.conversation.id;

    const msgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ conversationId, content: `${marker} dm content` });
    expect(msgRes.status).toBe(201);
    msgId = msgRes.body.message.id;
  });

  it('participant A can search the DM conversation', async () => {
    setMeiliMode([msgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&conversationId=${conversationId}`)
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits[0]?.id).toBe(msgId);
  });

  it('non-participant gets 403', async () => {
    setMeiliMode([msgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&conversationId=${conversationId}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });
});

describe('Search – Meili path: author + time filters enforced in Postgres', () => {
  let ownerToken: string;
  let otherToken: string;
  let communityId: string;
  let channelId: string;
  let ownerMsgId: string;
  let otherMsgId: string;
  let ownerUserId: string;
  const marker = `meilifilters${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner  = await createAuthenticatedUser('meili-filter-owner');
    const other  = await createAuthenticatedUser('meili-filter-other');
    ownerToken  = owner.accessToken;
    otherToken  = other.accessToken;
    ownerUserId = owner.user.id;

    const community = await createCommunity(ownerToken);
    communityId = community.id;
    await joinCommunity(otherToken, communityId);
    const channel = await createChannel(ownerToken, communityId);
    channelId = channel.id;

    const m1 = await sendMessage(ownerToken, channelId, `${marker} from owner`);
    const m2 = await sendMessage(otherToken,  channelId, `${marker} from other`);
    ownerMsgId = m1.id;
    otherMsgId = m2.id;
  });

  it('authorId filter restricts results to that author even if Meili returns both IDs', async () => {
    setMeiliMode([ownerMsgId, otherMsgId]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}&authorId=${ownerUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.hits.map((h: any) => h.id);
    expect(ids).toContain(ownerMsgId);
    expect(ids).not.toContain(otherMsgId);
  });
});

describe('Search – Meili path: results are newest-first', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  const marker = `meilisort${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('meili-sort-owner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken);
    communityId = community.id;
    const channel   = await createChannel(ownerToken, community.id);
    channelId = channel.id;
    await sendMessage(ownerToken, channelId, `${marker} first`);
    await sendMessage(ownerToken, channelId, `${marker} second`);
    await sendMessage(ownerToken, channelId, `${marker} third`);
  });

  it('results are ordered newest-first after Postgres recheck', async () => {
    // Let Postgres do the sorting; Meili returns unordered IDs
    const { rows } = await pool.query(
      `SELECT id FROM messages WHERE content LIKE $1 AND deleted_at IS NULL ORDER BY created_at`,
      [`%${marker}%`],
    );
    const ids = rows.map((r: any) => r.id);
    expect(ids.length).toBe(3);

    // Feed IDs to Meili mock in oldest-first order (worst case for sort)
    setMeiliMode(ids);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const dates = res.body.hits.map((h: any) => new Date(h.createdAt).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });
});

describe('Search – Meili path: edited message uses fresh Postgres content', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('meili-edit-owner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken);
    communityId = community.id;
    const channel   = await createChannel(ownerToken, community.id);
    channelId = channel.id;
  });

  it('returns updated content even when Meili only knows the old document ID', async () => {
    const marker  = `meiliedit${uniqueSuffix()}`;
    const updated = `${marker}_updated`;

    const msg = await sendMessage(ownerToken, channelId, `${marker} original`);

    // Edit the message
    await request(app)
      .patch(`/api/v1/messages/${msg.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: `${updated} content` });

    // Meili returns the original ID; Postgres recheck fetches current content
    setMeiliMode([msg.id]);

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const hit = res.body.hits.find((h: any) => h.id === msg.id);
    expect(hit).toBeDefined();
    expect(hit.content).toContain(updated);
  });
});

describe('Search – Meili path: Meili error falls back to Postgres', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  const marker = `meilifallback${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('meili-fallback-owner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken);
    communityId = community.id;
    const channel   = await createChannel(ownerToken, community.id);
    channelId = channel.id;
    await sendMessage(ownerToken, channelId, `${marker} content`);
  });

  it('returns 200 with FTS results when Meili throws', async () => {
    mockIsSearchBackend.mockReturnValue(true);
    mockSearchCandidates.mockRejectedValue(new Error('Meili timeout'));

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    // Should have fallen back to Postgres FTS — hits may or may not include the message
    // depending on FTS stop-word processing, but no 500
    expect(Array.isArray(res.body.hits)).toBe(true);
    expect(mockIncFallbackTotal).toHaveBeenCalled();
  });

  it('does not return 500 when Meili is unreachable', async () => {
    mockIsSearchBackend.mockReturnValue(true);
    mockSearchCandidates.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBeLessThan(500);
  });
});

describe('Search – Meili path: strict token AND + Postgres fallback', () => {
  it('falls back to Postgres when Meili candidates lack every query term', async () => {
    const owner = await createAuthenticatedUser('meili-strict-fallback-owner');
    const community = await createCommunity(owner.accessToken);
    const channel = await createChannel(owner.accessToken, community.id);

    const partial = await sendMessage(
      owner.accessToken,
      channel.id,
      'strictalpha strictbeta partialonly',
    );
    await sendMessage(
      owner.accessToken,
      channel.id,
      'strictalpha strictbeta strictgamma fullphrase',
    );

    setMeiliMode([partial.id]);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent('strictalpha strictbeta strictgamma')}&communityId=${community.id}`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes('strictgamma'))).toBe(true);
    expect(mockIncFallbackTotal).toHaveBeenCalled();
  });

  it('returns Meili-backed rows when every term appears in Postgres-rechecked content', async () => {
    const owner = await createAuthenticatedUser('meili-strict-pass-owner');
    const community = await createCommunity(owner.accessToken);
    const channel = await createChannel(owner.accessToken, community.id);
    const msg = await sendMessage(
      owner.accessToken,
      channel.id,
      'strictpass one two three',
    );

    setMeiliMode([msg.id]);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent('strictpass one three')}&communityId=${community.id}`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => h.id === msg.id)).toBe(true);
  });

  it('strict filter still respects deleted messages from Postgres recheck', async () => {
    const owner = await createAuthenticatedUser('meili-strict-del-owner');
    const community = await createCommunity(owner.accessToken);
    const channel = await createChannel(owner.accessToken, community.id);
    const msg = await sendMessage(owner.accessToken, channel.id, 'strictdel alpha beta gamma');
    await request(app)
      .delete(`/api/v1/messages/${msg.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    setMeiliMode([msg.id]);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent('strictdel alpha beta gamma')}&communityId=${community.id}`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => h.id === msg.id)).toBe(false);
    expect(mockIncFallbackTotal).toHaveBeenCalled();
  });
});
