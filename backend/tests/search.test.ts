/**
 * Search integration tests.
 *
 * Covers:
 *  - FTS query returns matching messages (channel, community, conversation, unscoped)
 *  - community-scoped search only returns messages from that community's channels
 *  - access control: non-member cannot search a private channel / community
 *  - single-character queries are allowed
 *  - highlight XSS sanitization (ts_headline output must be HTML-escaped)
 *  - FTS-first with scoped literal rescue when FTS returns zero hits (bounded, no trigram)
 */

import { request, app, wsServer, pool, closeRedisConnections } from './runtime';
import { uniqueSuffix, createAuthenticatedUser } from './helpers';

const logger = require('../src/utils/logger');

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Search – basic FTS', () => {
  let ownerToken: string;
  let channelId: string;
  const marker = `ftstestmarker${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchowner');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    const channel = await createChannel(ownerToken, community.id);
    channelId = channel.id;

    await sendMessage(ownerToken, channelId, `First message about ${marker}`);
    await sendMessage(ownerToken, channelId, `Second message with ${marker} again`);
    await sendMessage(ownerToken, channelId, 'Unrelated message about cats');
  });

  it('returns matching messages for a channel-scoped query', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&channelId=${channelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBe(2);
    expect(res.body.hits[0].channelId).toBe(channelId);
  });

  it('returns zero hits for a non-matching query', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=zzznomatch${uniqueSuffix()}&channelId=${channelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBe(0);
  });

  it('allows single-character queries', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=a&channelId=${channelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
  });

  it('includes communityId and channelName in each hit', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${marker}&channelId=${channelId}`)
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
      .get(`/api/v1/search?q=${marker}&channelId=${channelId}&limit=10`)
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

describe('Search – access control', () => {
  let ownerToken: string;
  let privateChannelId: string;
  let publicChannelId: string;
  const markerChannel = `accctrl${uniqueSuffix()}`;
  const markerPublic = `pubacc${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchac');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    const publicChannel = await createChannel(ownerToken, community.id, { isPrivate: false });
    publicChannelId = publicChannel.id;
    await sendMessage(ownerToken, publicChannelId, `Public message: ${markerPublic}`);
    // Use a PRIVATE channel so non-members are denied
    const channel = await createChannel(ownerToken, community.id, { isPrivate: true });
    privateChannelId = channel.id;
    await sendMessage(ownerToken, privateChannelId, `Secret message: ${markerChannel}`);
  });

  it('returns 403 when searching a private channel the user is not a member of', async () => {
    const outsider = await createAuthenticatedUser('srchout2');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerChannel}&channelId=${privateChannelId}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=${markerChannel}&channelId=${privateChannelId}`);

    expect(res.status).toBe(401);
  });

  it('returns 403 when searching a public channel without community membership', async () => {
    const outsider = await createAuthenticatedUser('srchoutpublic');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerPublic}&channelId=${publicChannelId}`)
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
  let channelId: string;
  const xssMarker = `xsstest${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchxss');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    const channel = await createChannel(ownerToken, community.id);
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
      .get(`/api/v1/search?q=${xssMarker}&channelId=${channelId}`)
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
      .get(`/api/v1/search?q=${partial}&channelId=${channelId}`)
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
  let channelId: string;
  const base = `trigfallback${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchtrig');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    const channel = await createChannel(ownerToken, community.id);
    channelId = channel.id;
    await sendMessage(ownerToken, channelId, `Partial match test: ${base}suffix`);
  });

  it('finds messages via partial/infix query (trigram fallback)', async () => {
    // FTS won't match a mid-word prefix; trigram ILIKE will
    const partial = base.slice(0, 6);
    const res = await request(app)
      .get(`/api/v1/search?q=${partial}&channelId=${channelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits[0].content).toContain(base);
  });
});

describe('Search – common phrases and all-term matching', () => {
  let ownerToken: string;
  let channelId: string;
  const exactPhrase = `games that have ${uniqueSuffix()}`;
  const commonPhrase = 'more just about';
  const shortPhrase = 'hi ed be';
  const boundaryPhrase = 'a lazy';

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchallterms');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
    const channel = await createChannel(ownerToken, community.id);
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
      .get(`/api/v1/search?q=${encodeURIComponent(`games ${uniqueTerm}`)}&channelId=${channelId}`)
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
      .get(`/api/v1/search?q=${encodeURIComponent(commonPhrase)}&channelId=${channelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hits.some((hit: any) => String(hit.content || '').includes(commonPhrase))).toBe(true);
  });

  it('single stop-word query uses scoped literal fallback', async () => {
    // "be" is an English stop word; the scoped literal fallback can still find
    // messages containing that literal token/string.
    const res = await request(app)
      .get(`/api/v1/search?q=be&channelId=${channelId}`)
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
      .get(`/api/v1/search?q=${encodeURIComponent(boundaryPhrase)}&channelId=${channelId}`)
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
        .get(`/api/v1/search?q=${encodeURIComponent(commonPhrase)}&channelId=${channelId}`)
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
      expect(trace.resolved_scope).toBe('channel');
      expect(typeof trace.requestId).toBe('string');
      expect(typeof trace.total_ms).toBe('number');
      expect(typeof trace.query_ms).toBe('number');
    });

    it('emits search_trace with fallback_used false when FTS returns hits', async () => {
      const uniqueTerm = exactPhrase.split(' ').pop()!;
      await request(app)
        .get(
          `/api/v1/search?q=${encodeURIComponent(`games ${uniqueTerm}`)}&channelId=${channelId}`,
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

describe('Search – channel scope is unsupported', () => {
  it('rejects requests that include channelId (including channelId=conversationId)', async () => {
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
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toContain('channelId scope is no longer supported');
  });
});

describe('Search – mutually exclusive community and conversation scopes', () => {
  it('rejects a real DM search when communityId and conversationId are both present', async () => {
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
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toContain('either communityId or conversationId');
  });

  it('rejects mixed scope even when conversationId happens to equal a channel id', async () => {
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
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toContain('either communityId or conversationId');
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
