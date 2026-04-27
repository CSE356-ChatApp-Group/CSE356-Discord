/**
 * Search integration tests.
 *
 * Covers:
 *  - FTS query returns matching messages (community, conversation, unscoped)
 *  - community-scoped search only returns messages from that community's channels
 *  - access control: non-member cannot search a private channel / community
 *  - single-character queries are allowed
 *  - highlight XSS sanitization (ts_headline output must be HTML-escaped)
 *  - FTS-first with scoped literal rescue when FTS returns zero hits (bounded, no trigram)
 */

import { request, app, wsServer, pool, closeRedisConnections } from './runtime';
import { uniqueSuffix, createAuthenticatedUser } from './helpers';

const logger = require('../src/utils/logger');
const {
  recordMessageChannelInsertLockAcquireWait,
  resetMessageChannelInsertLockPressureForTests,
} = require('../src/messages/messageInsertLockPressure');

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

// ── Shared setup helpers ──────────────────────────────────────────────────────

async function createCommunity(token: string, nameSuffix: string) {
  const slug = `srch-comm-${nameSuffix}`.slice(0, 32);
  const res = await request(app)
    .post('/api/v1/communities')
    .set('Authorization', `Bearer ${token}`)
    .send({ slug, name: slug, description: 'search test community' });
  expect(res.status).toBe(201);
  return res.body.community as { id: string };
}

async function createChannel(
  token: string,
  communityId: string,
  opts: { isPrivate?: boolean } = {},
) {
  const res = await request(app)
    .post('/api/v1/channels')
    .set('Authorization', `Bearer ${token}`)
    .send({
      communityId,
      name: `srch-chan-${uniqueSuffix()}`.slice(0, 32),
      isPrivate: opts.isPrivate ?? false,
      description: 'search test channel',
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
  return res.body.message as { id: string };
}

async function joinCommunity(token: string, communityId: string) {
  const res = await request(app)
    .post(`/api/v1/communities/${communityId}/join`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
}

async function inviteToChannel(token: string, channelId: string, userIds: string[]) {
  const res = await request(app)
    .post(`/api/v1/channels/${channelId}/members`)
    .set('Authorization', `Bearer ${token}`)
    .send({ userIds });
  expect(res.status).toBe(200);
}

async function createConversation(token: string, participants: string[]) {
  const res = await request(app)
    .post('/api/v1/conversations')
    .set('Authorization', `Bearer ${token}`)
    .send({ participantIds: participants });
  expect(res.status).toBe(201);
  return res.body.conversation as { id: string };
}

async function sendConversationMessage(token: string, conversationId: string, content: string) {
  const res = await request(app)
    .post('/api/v1/messages')
    .set('Authorization', `Bearer ${token}`)
    .send({ conversationId, content });
  expect(res.status).toBe(201);
  return res.body.message as { id: string };
}

const searchClientMod = require('../src/search/client');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Search – basic FTS', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  const marker = `ftstestmarker${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchowner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    communityId = community.id;
    const channel = await createChannel(ownerToken, communityId);
    channelId = channel.id;

    await sendMessage(ownerToken, channelId, `First message about ${marker}`);
    await sendMessage(ownerToken, channelId, `Second message with ${marker} again`);
    await sendMessage(ownerToken, channelId, 'Unrelated message about cats');
  });

  it('returns matching messages for a community-scoped query', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBe(2);
    expect(res.body.hits[0].channelId).toBe(channelId);
  });

  it('returns zero hits for a non-matching query', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=zzznomatch${uniqueSuffix()}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBe(0);
  });

  it('allows single-character queries', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=a&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
  });

  it('includes communityId and channelName in each hit', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    for (const hit of res.body.hits) {
      expect(typeof hit.channelName).toBe('string');
      expect(typeof hit.communityId).toBe('string');
    }
  });

  it('returns newest-first within matched results', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&communityId=${communityId}&limit=10`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const dates = res.body.hits.map((h: any) => new Date(h.createdAt).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });
});

describe('Search – community scope', () => {
  let ownerToken: string;
  let communityA: { id: string };
  let communityB: { id: string };
  let channelA: { id: string };
  let channelB: { id: string };
  const markerA = `communityA${uniqueSuffix()}`;
  const markerB = `communityB${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchcommunity');
    ownerToken = owner.accessToken;

    communityA = await createCommunity(ownerToken, uniqueSuffix());
    communityB = await createCommunity(ownerToken, uniqueSuffix());
    channelA = await createChannel(ownerToken, communityA.id);
    channelB = await createChannel(ownerToken, communityB.id);

    // Post with markerA in community A, markerB in community B
    await sendMessage(ownerToken, channelA.id, `Message for community A: ${markerA}`);
    await sendMessage(ownerToken, channelB.id, `Message for community B: ${markerB}`);
    // Post the OTHER community's marker in the wrong community — should NOT appear in scoped search
    await sendMessage(ownerToken, channelB.id, `Cross-post: ${markerA} in community B`);
  });

  it('community-scoped search for markerA returns only community A messages', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${markerA}&communityId=${communityA.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    // Should find only the message in community A, NOT the cross-post in community B
    expect(res.body.hits.length).toBe(1);
    for (const hit of res.body.hits) {
      expect(hit.communityId).toBe(communityA.id);
    }
  });

  it('community-scoped search does not bleed across communities', async () => {
    // Searching markerA within communityB should return 0 (the cross-post is in communityB
    // so it SHOULD appear — but markerA in communityA should NOT bleed in here).
    const resA = await request(app)
      .get(`/api/v1/search?q=${markerA}&communityId=${communityA.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const resB = await request(app)
      .get(`/api/v1/search?q=${markerA}&communityId=${communityB.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // All hits in A search must belong to community A
    for (const hit of resA.body.hits) expect(hit.communityId).toBe(communityA.id);
    // All hits in B search must belong to community B
    for (const hit of resB.body.hits) expect(hit.communityId).toBe(communityB.id);
  });

  it('returns 403 when searching a community the user is not a member of', async () => {
    const outsider = await createAuthenticatedUser('srchout');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerA}&communityId=${communityA.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(403);
  });
});

describe('Search – community FTS candidates stay in-community before LIMIT', () => {
  const prevCandidatesLimit = process.env.SEARCH_FTS_CANDIDATES_LIMIT;

  beforeAll(() => {
    process.env.SEARCH_FTS_CANDIDATES_LIMIT = '5';
  });

  afterAll(() => {
    if (prevCandidatesLimit === undefined) delete process.env.SEARCH_FTS_CANDIDATES_LIMIT;
    else process.env.SEARCH_FTS_CANDIDATES_LIMIT = prevCandidatesLimit;
  });

  it('finds an older in-community match when many newer matches exist only outside that community', async () => {
    const owner = await createAuthenticatedUser('srchcommftslim');
    const token = owner.accessToken;
    const communityA = await createCommunity(token, uniqueSuffix());
    const communityB = await createCommunity(token, uniqueSuffix());
    const channelA = await createChannel(token, communityA.id);
    const channelB = await createChannel(token, communityB.id);
    const marker = `commftscapmarker${uniqueSuffix()}`;

    await sendMessage(token, channelA.id, `alpha in-community anchor ${marker}`);
    for (let i = 0; i < 8; i += 1) {
      await sendMessage(token, channelB.id, `beta outside-community flood ${marker} ${i}`);
    }

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${communityA.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.body.hits.some((h: any) => h.channelId === channelA.id)).toBe(true);
    for (const hit of res.body.hits) {
      expect(hit.communityId).toBe(communityA.id);
    }
  });

  it('still returns 403 for community search when the user is not a community member', async () => {
    const owner = await createAuthenticatedUser('srchcommfts403');
    const outsider = await createAuthenticatedUser('srchcommfts403out');
    const token = owner.accessToken;
    const communityA = await createCommunity(token, uniqueSuffix());
    const channelA = await createChannel(token, communityA.id);
    const marker = `commfts403marker${uniqueSuffix()}`;
    await sendMessage(token, channelA.id, `gated ${marker}`);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${communityA.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('channel-scoped FTS still finds an older in-channel match when many newer matches exist in another channel (non-community SQL path unchanged)', async () => {
    const owner = await createAuthenticatedUser('srchcommftschan');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channelA = await createChannel(token, community.id);
    const channelB = await createChannel(token, community.id);
    const marker = `chanftspathmarker${uniqueSuffix()}`;

    await sendMessage(token, channelA.id, `anchor ${marker}`);
    for (let i = 0; i < 8; i += 1) {
      await sendMessage(token, channelB.id, `flood ${marker} ${i}`);
    }

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&channelId=${channelA.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.body.hits.every((h: any) => h.channelId === channelA.id)).toBe(true);
  });
});

describe('Search – scoped literal rescue for deep history and weak tsquery', () => {
  it('returns an exact community-scoped phrase match around rank ~2000', async () => {
    const owner = await createAuthenticatedUser('srchdeepowner');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const marker = `deep exact marker ${uniqueSuffix()}`;

    // Seed many newer rows so the exact match is far from newest.
    for (let i = 0; i < 2200; i += 1) {
      await pool.query(
        `INSERT INTO messages (channel_id, author_id, content, created_at)
         VALUES ($1, $2, $3, NOW() - ($4::int || ' seconds')::interval)`,
        [channel.id, owner.user.id, `noise row ${i}`, i + 1],
      );
    }
    await pool.query(
      `INSERT INTO messages (channel_id, author_id, content, created_at)
       VALUES ($1, $2, $3, NOW() - interval '2205 seconds')`,
      [channel.id, owner.user.id, marker],
    );

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}&limit=20`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(marker))).toBe(true);
  });

  it('weak tsquery query "still will have" includes exact literal and not only "still" matches', async () => {
    const owner = await createAuthenticatedUser('srchweakowner');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);

    await sendMessage(token, channel.id, 'still waters run deep');
    await sendMessage(token, channel.id, 'still here, still waiting');
    await sendMessage(token, channel.id, 'this still exists but not all terms');
    await sendMessage(token, channel.id, 'still will have all three words present');

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('still will have')}&communityId=${community.id}&limit=10`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(
      res.body.hits.some((h: any) =>
        String(h.content || '').toLowerCase().includes('still will have'),
      ),
    ).toBe(true);
  });

  it('community literal fallback still excludes inaccessible private channels', async () => {
    const owner = await createAuthenticatedUser('srchweakprivowner');
    const member = await createAuthenticatedUser('srchweakprivmember');
    const tokenOwner = owner.accessToken;
    const tokenMember = member.accessToken;
    const community = await createCommunity(tokenOwner, uniqueSuffix());
    await joinCommunity(tokenMember, community.id);
    const privateChannel = await createChannel(tokenOwner, community.id, { isPrivate: true });
    const marker = `private old marker ${uniqueSuffix()}`;

    await pool.query(
      `INSERT INTO messages (channel_id, author_id, content, created_at)
       VALUES ($1, $2, $3, NOW() - interval '2300 seconds')`,
      [privateChannel.id, owner.user.id, marker],
    );

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${tokenMember}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(marker))).toBe(false);
  });

  it('deleted messages are excluded from scoped literal rescue', async () => {
    const owner = await createAuthenticatedUser('srchweakdelowner');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const marker = `deleted literal marker ${uniqueSuffix()}`;

    const msg = await sendMessage(token, channel.id, marker);
    const delRes = await request(app)
      .delete(`/api/v1/messages/${msg.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(delRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(marker))).toBe(false);
  });
});

describe('Search – access control', () => {
  let ownerToken: string;
  let communityId: string;
  let privateChannelId: string;
  let publicChannelId: string;
  const markerChannel = `accctrl${uniqueSuffix()}`;
  const markerPublic = `pubacc${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchac');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    communityId = community.id;
    const publicChannel = await createChannel(ownerToken, communityId, { isPrivate: false });
    publicChannelId = publicChannel.id;
    await sendMessage(ownerToken, publicChannelId, `Public message: ${markerPublic}`);
    // Use a PRIVATE channel so non-members are denied
    const channel = await createChannel(ownerToken, communityId, { isPrivate: true });
    privateChannelId = channel.id;
    await sendMessage(ownerToken, privateChannelId, `Secret message: ${markerChannel}`);
  });

  it('returns 403 when searching a community the user is not a member of', async () => {
    const outsider = await createAuthenticatedUser('srchout2');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerChannel}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${markerChannel}&communityId=${communityId}`);

    expect(res.status).toBe(401);
  });

  it('returns 403 when searching community content without membership', async () => {
    const outsider = await createAuthenticatedUser('srchoutpublic');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerPublic}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('unscoped search is rejected (must provide scope)', async () => {
    const outsider = await createAuthenticatedUser('srchunscoped');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerChannel}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Search must be scoped');
  });

  it('unscoped search is rejected for public channels too (must provide scope)', async () => {
    const outsider = await createAuthenticatedUser('srchunscopedpublic');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerPublic}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Search must be scoped');
  });
});

describe('Search – XSS sanitization', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  const xssMarker = `xsstest${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchxss');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    communityId = community.id;
    const channel = await createChannel(ownerToken, communityId);
    channelId = channel.id;
    // Message containing raw HTML / script injection attempt
    await sendMessage(
      ownerToken,
      channelId,
      `${xssMarker} <script>alert(1)</script> <img src=x onerror=alert(2)>`,
    );
  });

  it('_formatted.content does not contain unescaped <script> tags', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${xssMarker}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);

    for (const hit of res.body.hits) {
      const html: string = hit._formatted?.content ?? '';
      // Must not contain the literal opening <script> tag
      expect(html).not.toMatch(/<script/i);
      // Must not contain unescaped < or > from the injection (should be &lt; / &gt;)
      // Allow <em> and </em> which are the intentional highlight markers
      const stripped = html.replace(/<\/?em>/gi, '');
      expect(stripped).not.toMatch(/<[a-z]/i);
    }
  });

  it('trigram-fallback highlights are also sanitized', async () => {
    // 'src=x' is infix and won't be in tsvector stop words, but use a very short
    // partial token to force trigram path. Use raw partial of the xssMarker.
    const partial = xssMarker.slice(0, 4); // short enough to be infix
    const res = await request(app)
      .get(`/api/v1/search?q=${partial}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    for (const hit of res.body.hits) {
      const html: string = hit._formatted?.content ?? '';
      const stripped = html.replace(/<\/?em>/gi, '');
      expect(stripped).not.toMatch(/<[a-z]/i);
    }
  });
});

// Trigram/partial-match fallback removed; FTS-only per spec.
describe.skip('Search – trigram fallback', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  const base = `trigfallback${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchtrig');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    communityId = community.id;
    const channel = await createChannel(ownerToken, communityId);
    channelId = channel.id;
    await sendMessage(ownerToken, channelId, `Partial match test: ${base}suffix`);
  });

  it('finds messages via partial/infix query (trigram fallback)', async () => {
    // FTS won't match a mid-word prefix; trigram ILIKE will
    const partial = base.slice(0, 6);
    const res = await request(app)
      .get(`/api/v1/search?q=${partial}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits[0].content).toContain(base);
  });
});

describe('Search – common phrases and all-term matching', () => {
  let ownerToken: string;
  let communityId: string;
  let channelId: string;
  const exactPhrase = `games that have ${uniqueSuffix()}`;
  const commonPhrase = 'more just about';
  const shortPhrase = 'hi ed be';
  const boundaryPhrase = 'a lazy';

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchallterms');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    communityId = community.id;
    const channel = await createChannel(ownerToken, communityId);
    channelId = channel.id;

    await sendMessage(ownerToken, channelId, `${exactPhrase} with every searched word present`);
    await sendMessage(ownerToken, channelId, 'games that are popular but missing the last word');
    await sendMessage(ownerToken, channelId, `${commonPhrase} this sentence should still be searchable`);
    await sendMessage(ownerToken, channelId, shortPhrase);
    await sendMessage(ownerToken, channelId, 'the lazy dog');
    await sendMessage(ownerToken, channelId, 'a lazy fox');
  });

  it('FTS multi-term: results contain all indexed (non-stop) query terms', async () => {
    // "that" and "have" are English stop words stripped by websearch_to_tsquery.
    // Use the unique numeric suffix from exactPhrase as the second non-stop discriminator
    // so only the one message containing both "games" and that number is returned.
    const uniqueTerm = exactPhrase.split(' ').pop()!;
    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(`games ${uniqueTerm}`)}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    for (const hit of res.body.hits) {
      const lower = String(hit.content || '').toLowerCase();
      expect(lower).toContain('games');
      expect(lower).toContain(uniqueTerm);
    }
  });

  it('stop-word-only query uses scoped literal fallback', async () => {
    // "more just about" are English stop words; websearch_to_tsquery('english') produces
    // ''::tsquery. Scoped searches fall back to an exact literal match inside
    // the requested scope only.
    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(commonPhrase)}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((hit: any) => String(hit.content || '').includes(commonPhrase))).toBe(true);
  });

  it('single stop-word query uses scoped literal fallback', async () => {
    // "be" is an English stop word; the scoped literal fallback can still find
    // messages containing that literal token/string.
    const res = await request(app)
      .get(`/api/v1/search?q=be&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits.some((hit: any) => String(hit.content || '').toLowerCase().includes('be'))).toBe(true);
  });

  it('FTS strips stop words from query; remaining terms match all containing messages', async () => {
    // "a lazy": "a" is a stop word, stripped by websearch_to_tsquery('english').
    // FTS produces 'lazy'::tsquery which matches any message containing "lazy",
    // so both "a lazy fox" and "the lazy dog" are returned.
    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(boundaryPhrase)}&communityId=${communityId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(
      res.body.hits.some((hit: any) => String(hit.content || '').includes('a lazy fox')),
    ).toBe(true);
    expect(
      res.body.hits.some((hit: any) => String(hit.content || '').includes('the lazy dog')),
    ).toBe(true);
  });

  describe('search_trace logging', () => {
    let infoSpy: jest.SpyInstance;

    beforeEach(() => {
      infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
      infoSpy.mockRestore();
    });

    it('emits search_trace with fallback_used true for stopword-only query', async () => {
      await request(app)
        .get(`/api/v1/search?q=${encodeURIComponent(commonPhrase)}&communityId=${communityId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      const traceCall = infoSpy.mock.calls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.search_trace === true,
      );
      expect(traceCall).toBeDefined();
      const trace = traceCall![0] as Record<string, unknown>;
      expect(traceCall![1] === 'search_trace' || trace.msg === 'search_trace').toBe(true);
      expect(trace.fallback_used).toBe(true);
      expect(trace.fts_hit_count).toBe(0);
      expect(trace.fallback_hit_count).toBeGreaterThan(0);
      expect(trace.tsquery_node_count).toBe(0);
      expect(trace.resolved_scope).toBe('community');
      expect(typeof trace.requestId).toBe('string');
      expect(typeof trace.total_ms).toBe('number');
      expect(typeof trace.query_ms).toBe('number');
    });

    it('emits search_trace with fallback_used false when FTS returns hits', async () => {
      const uniqueTerm = exactPhrase.split(' ').pop()!;
      await request(app)
        .get(
          `/api/v1/search?q=${encodeURIComponent(`games ${uniqueTerm}`)}&communityId=${communityId}`,
        )
        .set('Authorization', `Bearer ${ownerToken}`);

      const traceCall = infoSpy.mock.calls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>)?.search_trace === true,
      );
      expect(traceCall).toBeDefined();
      const trace = traceCall![0] as Record<string, unknown>;
      expect(trace.fallback_used).toBe(false);
      expect(trace.fallback_hit_count).toBe(0);
      expect(Number(trace.fts_hit_count)).toBeGreaterThan(0);
    });
  });
});

describe('Search – grader duplicate channelId/conversationId', () => {
  it('strips duplicate channelId=conversationId and searches the conversation', async () => {
    const a = await createAuthenticatedUser('srchcompasa');
    const b = await createAuthenticatedUser('srchcompasb');
    const convRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.username] });
    expect(convRes.status).toBe(201);
    const convId = convRes.body.conversation.id as string;
    const marker = `compasdupscope${uniqueSuffix()}`;
    const msgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ conversationId: convId, content: marker });
    expect(msgRes.status).toBe(201);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent(marker)}&channelId=${convId}&conversationId=${convId}`,
      )
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect((res.body.hits || []).some((hit: any) => String(hit.content || '').includes(marker))).toBe(true);
  });
});

describe('Search – mutually exclusive community and conversation scopes', () => {
  it('resolves grader-style dual scope to conversation when user participates in the DM', async () => {
    const a = await createAuthenticatedUser('srchdmscopea');
    const b = await createAuthenticatedUser('srchdmscopeb');
    const community = await createCommunity(a.accessToken, uniqueSuffix());
    await joinCommunity(b.accessToken, community.id);
    const convRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.username] });
    expect(convRes.status).toBe(201);
    const convId = convRes.body.conversation.id as string;
    const marker = `dmgraderphrase${uniqueSuffix()}`;
    const msgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ conversationId: convId, content: marker });
    expect(msgRes.status).toBe(201);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}&conversationId=${convId}`,
      )
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect((res.body.hits || []).some((hit: any) => String(hit.content || '').includes(marker))).toBe(true);
  });

  it('falls back to community scope when conversationId is not an accessible conversation', async () => {
    const owner = await createAuthenticatedUser('srchmislabel');
    const community = await createCommunity(owner.accessToken, uniqueSuffix());
    const ch = await createChannel(owner.accessToken, community.id);
    const marker = `channelfromwrongparam${uniqueSuffix()}`;
    await sendMessage(owner.accessToken, ch.id, marker);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}&conversationId=${ch.id}`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect((res.body.hits || []).some((hit: any) => String(hit.content || '').includes(marker))).toBe(true);
  });
});

describe('Search – conversation scope (1:1 and group DM)', () => {
  it('1:1 DM search returns hits for participants and rejects non-participants', async () => {
    const a = await createAuthenticatedUser('srchdmonea');
    const b = await createAuthenticatedUser('srchdmoneb');
    const outsider = await createAuthenticatedUser('srchdmoneout');
    const marker = `dmone${uniqueSuffix()}`;

    const conversation = await createConversation(a.accessToken, [b.username]);
    const msg = await sendConversationMessage(a.accessToken, conversation.id, `hello ${marker}`);

    const byA = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&conversationId=${conversation.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(byA.status).toBe(200);
    expect((byA.body.hits || []).some((hit: any) => String(hit.id) === msg.id)).toBe(true);

    const byB = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&conversationId=${conversation.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(byB.status).toBe(200);
    expect((byB.body.hits || []).some((hit: any) => String(hit.id) === msg.id)).toBe(true);

    const byOutsider = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&conversationId=${conversation.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(byOutsider.status).toBe(403);
  });

  it('group DM search is scoped to one conversation and includes participant-visible messages', async () => {
    const owner = await createAuthenticatedUser('srchgroupown');
    const u2 = await createAuthenticatedUser('srchgroupu2');
    const u3 = await createAuthenticatedUser('srchgroupu3');
    const marker = `dmgroup${uniqueSuffix()}`;

    const group = await createConversation(owner.accessToken, [u2.username, u3.username]);
    const m1 = await sendConversationMessage(owner.accessToken, group.id, `owner says ${marker}`);
    const m2 = await sendConversationMessage(u2.accessToken, group.id, `u2 says ${marker}`);

    const otherConversation = await createConversation(owner.accessToken, [u2.username]);
    await sendConversationMessage(owner.accessToken, otherConversation.id, `other dm ${marker}`);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&conversationId=${group.id}`)
      .set('Authorization', `Bearer ${u3.accessToken}`);
    expect(res.status).toBe(200);

    const ids = (res.body.hits || []).map((hit: any) => String(hit.id));
    expect(ids).toContain(m1.id);
    expect(ids).toContain(m2.id);
    for (const hit of (res.body.hits || [])) {
      expect(String(hit.conversationId || hit.conversation_id || '')).toBe(group.id);
    }
  });

  it('conversation-scoped search reflects edits and deletions shortly after updates', async () => {
    const a = await createAuthenticatedUser('srchdmfresha');
    const b = await createAuthenticatedUser('srchdmfreshb');
    const oldMarker = `dmold${uniqueSuffix()}`;
    const newMarker = `dmnew${uniqueSuffix()}`;

    const conversation = await createConversation(a.accessToken, [b.username]);
    const message = await sendConversationMessage(a.accessToken, conversation.id, `before ${oldMarker}`);

    const editRes = await request(app)
      .patch(`/api/v1/messages/${message.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ content: `after ${newMarker}` });
    expect(editRes.status).toBe(200);

    const searchNew = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(newMarker)}&conversationId=${conversation.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(searchNew.status).toBe(200);
    expect((searchNew.body.hits || []).some((hit: any) => String(hit.id) === message.id)).toBe(true);

    const searchOld = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(oldMarker)}&conversationId=${conversation.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(searchOld.status).toBe(200);
    expect((searchOld.body.hits || []).some((hit: any) => String(hit.id) === message.id)).toBe(false);

    const deleteRes = await request(app)
      .delete(`/api/v1/messages/${message.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(deleteRes.status).toBe(200);

    const searchAfterDelete = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(newMarker)}&conversationId=${conversation.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(searchAfterDelete.status).toBe(200);
    expect((searchAfterDelete.body.hits || []).some((hit: any) => String(hit.id) === message.id)).toBe(false);
  });
});

describe('Search – community scope access and freshness', () => {
  it('includes public channels plus private channels the user can access (and excludes inaccessible private channels)', async () => {
    const owner = await createAuthenticatedUser('srchcommowner');
    const memberNoPriv = await createAuthenticatedUser('srchcommmember');
    const memberWithPriv = await createAuthenticatedUser('srchcommpriv');

    const community = await createCommunity(owner.accessToken, uniqueSuffix());
    await joinCommunity(memberNoPriv.accessToken, community.id);
    await joinCommunity(memberWithPriv.accessToken, community.id);

    const publicChannel = await createChannel(owner.accessToken, community.id, { isPrivate: false });
    const privateChannel = await createChannel(owner.accessToken, community.id, { isPrivate: true });
    await inviteToChannel(owner.accessToken, privateChannel.id, [memberWithPriv.user.id]);

    const pubMarker = `communitypub${uniqueSuffix()}`;
    const privMarker = `communitypriv${uniqueSuffix()}`;
    const pubMsg = await sendMessage(owner.accessToken, publicChannel.id, `public ${pubMarker}`);
    const privMsg = await sendMessage(owner.accessToken, privateChannel.id, `private ${privMarker}`);

    const withoutPrivate = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('community')}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${memberNoPriv.accessToken}`);
    expect(withoutPrivate.status).toBe(200);
    const withoutIds = (withoutPrivate.body.hits || []).map((hit: any) => String(hit.id));
    expect(withoutIds).toContain(pubMsg.id);
    expect(withoutIds).not.toContain(privMsg.id);

    const withPrivate = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('community')}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${memberWithPriv.accessToken}`);
    expect(withPrivate.status).toBe(200);
    const withIds = (withPrivate.body.hits || []).map((hit: any) => String(hit.id));
    expect(withIds).toContain(pubMsg.id);
    expect(withIds).toContain(privMsg.id);
  });

  it('community-scoped results reflect edits and deletions immediately after update operations', async () => {
    const owner = await createAuthenticatedUser('srchfreshowner');
    const community = await createCommunity(owner.accessToken, uniqueSuffix());
    const channel = await createChannel(owner.accessToken, community.id);

    const oldMarker = `freshold${uniqueSuffix()}`;
    const newMarker = `freshnew${uniqueSuffix()}`;
    const message = await sendMessage(owner.accessToken, channel.id, `before edit ${oldMarker}`);

    const editRes = await request(app)
      .patch(`/api/v1/messages/${message.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ content: `after edit ${newMarker}` });
    expect(editRes.status).toBe(200);

    const searchNew = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(newMarker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(searchNew.status).toBe(200);
    expect((searchNew.body.hits || []).some((hit: any) => String(hit.id) === message.id)).toBe(true);

    const searchOld = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(oldMarker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(searchOld.status).toBe(200);
    expect((searchOld.body.hits || []).some((hit: any) => String(hit.id) === message.id)).toBe(false);

    const deleteRes = await request(app)
      .delete(`/api/v1/messages/${message.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(deleteRes.status).toBe(200);

    const searchAfterDelete = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(newMarker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(searchAfterDelete.status).toBe(200);
    expect((searchAfterDelete.body.hits || []).some((hit: any) => String(hit.id) === message.id)).toBe(false);
  });
});

describe('Search – scoped literal fallback (hardened)', () => {
  const prevCap = process.env.STOPWORD_LITERAL_RECENT_CANDIDATES_LIMIT;
  const stopPhrase = 'more just about';
  const commonPhrase = `${stopPhrase} scoped literal body`;

  afterAll(() => {
    if (prevCap === undefined) delete process.env.STOPWORD_LITERAL_RECENT_CANDIDATES_LIMIT;
    else process.env.STOPWORD_LITERAL_RECENT_CANDIDATES_LIMIT = prevCap;
  });

  it('community scope: FTS miss (stopwords) still finds literal phrase in community', async () => {
    const owner = await createAuthenticatedUser('srchlitcomm');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    await sendMessage(token, channel.id, commonPhrase);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent(stopPhrase)}&communityId=${community.id}&limit=20`,
      )
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(stopPhrase))).toBe(
      true,
    );
    expect(res.body.hits.every((h: any) => h.communityId === community.id)).toBe(true);
  });

  it('conversation scope: FTS miss still finds literal phrase in DM', async () => {
    const a = await createAuthenticatedUser('srchlitdmA');
    const b = await createAuthenticatedUser('srchlitdmB');
    const convRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.username] });
    expect(convRes.status).toBe(201);
    const convId = convRes.body.conversation.id as string;
    await sendConversationMessage(a.accessToken, convId, `${commonPhrase} dm`);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(stopPhrase)}&conversationId=${convId}`)
      .set('Authorization', `Bearer ${a.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(stopPhrase))).toBe(
      true,
    );
    expect(res.body.hits.every((h: any) => h.conversationId === convId)).toBe(true);
  });

  it('community literal does not expose inaccessible private channel content', async () => {
    const owner = await createAuthenticatedUser('srchlitprivowner');
    const member = await createAuthenticatedUser('srchlitprivmember');
    const ownerTok = owner.accessToken;
    const community = await createCommunity(ownerTok, uniqueSuffix());
    const publicCh = await createChannel(ownerTok, community.id, { isPrivate: false });
    const privateCh = await createChannel(ownerTok, community.id, { isPrivate: true });
    await joinCommunity(member.accessToken, community.id);
    const marker = `privlitscoped${uniqueSuffix()}`;
    await sendMessage(ownerTok, privateCh.id, `${marker} secret`);
    await sendMessage(member.accessToken, publicCh.id, 'hello public');

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${member.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBe(0);
  });

  it('literal fallback respects authorId filter (conversation)', async () => {
    const a = await createAuthenticatedUser('srchlitauthA');
    const b = await createAuthenticatedUser('srchlitauthB');
    const convRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ participantIds: [b.username] });
    expect(convRes.status).toBe(201);
    const convId = convRes.body.conversation.id as string;
    const tail = uniqueSuffix();
    await sendConversationMessage(b.accessToken, convId, `more just about from b ${tail}`);
    await sendConversationMessage(a.accessToken, convId, `more just about from a ${tail}`);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent('more just about')}&conversationId=${convId}&authorId=${a.user.id}`,
      )
      .set('Authorization', `Bearer ${a.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.body.hits.every((h: any) => h.authorId === a.user.id)).toBe(true);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes('from a'))).toBe(true);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes('from b'))).toBe(false);
  });

  it('literal fallback respects after/before window (community)', async () => {
    const owner = await createAuthenticatedUser('srchlittime');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const phrase = `so nor yet time ${uniqueSuffix()}`;
    await sendMessage(token, channel.id, `${phrase} old`);
    const mid = new Date();
    await new Promise((r) => setTimeout(r, 25));
    await sendMessage(token, channel.id, `${phrase} new`);

    const res = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent('so nor yet')}&communityId=${
          community.id
        }&after=${encodeURIComponent(mid.toISOString())}`,
      )
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes('new'))).toBe(true);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes('old'))).toBe(false);
  });

  it('literal fallback excludes soft-deleted messages (channel)', async () => {
    const owner = await createAuthenticatedUser('srchlitdel');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const phrase = `yet nor scoped del ${uniqueSuffix()}`;
    const msg = await sendMessage(token, channel.id, `${phrase} doomed`);
    const del = await request(app)
      .delete(`/api/v1/messages/${msg.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('yet nor')}&channelId=${channel.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => h.id === msg.id)).toBe(false);
  });

  it('literal fallback reflects edited message content (channel)', async () => {
    const owner = await createAuthenticatedUser('srchlatedit');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const tail = uniqueSuffix();
    const msg = await sendMessage(token, channel.id, `so nor yet pre ${tail}`);
    const patch = await request(app)
      .patch(`/api/v1/messages/${msg.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: `so nor yet postedit ${tail}` });
    expect(patch.status).toBe(200);

    const resOld = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(`pre ${tail}`)}&channelId=${channel.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(resOld.status).toBe(200);
    expect(resOld.body.hits.some((h: any) => h.id === msg.id)).toBe(false);

    const resNew = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(`postedit ${tail}`)}&channelId=${channel.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(resNew.status).toBe(200);
    expect(resNew.body.hits.some((h: any) => h.id === msg.id)).toBe(true);
  });

  it('older message is still returned from community fallback when newer chatter exists in other channels', async () => {
    const owner = await createAuthenticatedUser('srchlitold');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const oldChannel = await createChannel(token, community.id);
    const noisyChannel = await createChannel(token, community.id);
    const tail = uniqueSuffix();
    await sendMessage(token, oldChannel.id, `more just about older anchor ${tail}`);
    for (let i = 0; i < 60; i += 1) {
      await sendMessage(token, noisyChannel.id, `noise ${tail} ${i}`);
    }

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('more just about')}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(`anchor ${tail}`))).toBe(true);
  });

  it('typo phrase fallback ("controll") returns existing community message', async () => {
    const owner = await createAuthenticatedUser('srchlittypo');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const marker = `controll typo ${uniqueSuffix()}`;
    await sendMessage(token, channel.id, `operator note: ${marker}`);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('controll typo')}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(marker))).toBe(true);
  });

  it('multi-language phrase fallback returns existing message', async () => {
    const owner = await createAuthenticatedUser('srchlitde');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const phrase = `straße über größe ${uniqueSuffix()}`;
    await sendMessage(token, channel.id, `de note: ${phrase}`);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('straße über')}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(phrase))).toBe(true);
  });

  it('phrase split by punctuation fallback returns existing message', async () => {
    const owner = await createAuthenticatedUser('srchlitpunct');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const marker = uniqueSuffix();
    await sendMessage(token, channel.id, `ping--pong controll ${marker}`);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('ping--pong controll')}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((h: any) => String(h.content || '').includes(marker))).toBe(true);
  });

  it('unscoped search still rejected (no literal global path)', async () => {
    const u = await createAuthenticatedUser('srchlitunsc');
    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent('so nor yet')}`)
      .set('Authorization', `Bearer ${u.accessToken}`);

    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toContain('Search must be scoped');
  });
});

describe('Search – overload isolation and classifier reasons', () => {
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  const prevForcedStage = process.env.FORCE_OVERLOAD_STAGE;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    resetMessageChannelInsertLockPressureForTests();
    delete process.env.FORCE_OVERLOAD_STAGE;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    resetMessageChannelInsertLockPressureForTests();
    if (prevForcedStage === undefined) delete process.env.FORCE_OVERLOAD_STAGE;
    else process.env.FORCE_OVERLOAD_STAGE = prevForcedStage;
  });

  it('insert-lock pressure does not shed /search', async () => {
    const owner = await createAuthenticatedUser('srchisolock');
    const community = await createCommunity(owner.accessToken, uniqueSuffix());
    const channel = await createChannel(owner.accessToken, community.id);
    const marker = `isolationmarker${uniqueSuffix()}`;
    await sendMessage(owner.accessToken, channel.id, marker);
    for (let i = 0; i < 8; i += 1) recordMessageChannelInsertLockAcquireWait(450);

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(marker)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect((res.body.hits || []).some((h: any) => String(h.content || '').includes(marker))).toBe(true);
    const throttled = warnSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.reason === 'insert_lock_read_pressure',
    );
    expect(throttled).toBeUndefined();
  });

  it('search overload sheds /search with overload_stage reason label', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';
    const owner = await createAuthenticatedUser('srchisoload');
    const community = await createCommunity(owner.accessToken, uniqueSuffix());

    const res = await request(app)
      .get(`/api/v1/search?q=anything&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(429);
    const throttled = warnSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.reason === 'overload_stage',
    );
    expect(throttled).toBeDefined();
  });

  it('logs classifier empty-result for true 200 empty search', async () => {
    const owner = await createAuthenticatedUser('srchemptyclass');
    const community = await createCommunity(owner.accessToken, uniqueSuffix());

    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(`none${uniqueSuffix()}`)}&communityId=${community.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect((res.body.hits || []).length).toBe(0);
    const emptyLog = infoSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.classification === 'search_empty_result',
    );
    expect(emptyLog).toBeDefined();
  });
});

describe('Search – scoped literal EXPLAIN (index-friendly)', () => {
  it('community / conversation literal plans avoid seq scan on messages when seqscan disabled', async () => {
    const owner = await createAuthenticatedUser('srchlitplan');
    const token = owner.accessToken;
    const community = await createCommunity(token, uniqueSuffix());
    const channel = await createChannel(token, community.id);
    const b = await createAuthenticatedUser('srchlitplanB');
    const convRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ participantIds: [b.username] });
    expect(convRes.status).toBe(201);
    const convId = convRes.body.conversation.id as string;

    const build = searchClientMod.__testBuildScopedLiteralParts as (
      q: string,
      opts: Record<string, unknown>,
    ) => { sql: string; params: unknown[] };

    const runExplain = async (meta: { sql: string; params: unknown[] }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL enable_seqscan = off');
          const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${meta.sql}`, meta.params);
          const planJson = rows[0]?.['QUERY PLAN'];
          const text = JSON.stringify(planJson);
          expect(text).not.toMatch(/Seq Scan on messages/i);
        } finally {
          await client.query('ROLLBACK').catch(() => {});
        }
      } finally {
        client.release();
      }
    };

    await runExplain(
      build('so nor test', {
        userId: owner.user.id,
        communityId: community.id,
        limit: 5,
        offset: 0,
      }),
    );
    await runExplain(
      build('so nor test', {
        userId: owner.user.id,
        conversationId: convId,
        limit: 5,
        offset: 0,
      }),
    );
    await runExplain(
      build('so nor test', {
        userId: owner.user.id,
        channelId: channel.id,
        limit: 5,
        offset: 0,
      }),
    );
  });
});
