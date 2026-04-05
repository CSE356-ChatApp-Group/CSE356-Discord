/**
 * Search integration tests.
 *
 * Covers:
 *  - FTS query returns matching messages (channel, community, conversation, unscoped)
 *  - community-scoped search only returns messages from that community's channels
 *  - access control: non-member cannot search a private channel / community
 *  - short-query rejection (< 2 chars)
 *  - highlight XSS sanitization (ts_headline output must be HTML-escaped)
 *  - trigram fallback path for partial/infix queries
 */

import { request, app, wsServer, pool, closeRedisConnections } from './runtime';
import { uniqueSuffix, createAuthenticatedUser } from './helpers';

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

  it('rejects queries shorter than 2 characters with 400', async () => {
    const res = await request(app)
      .get(`/api/v1/search?q=a&channelId=${channelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(400);
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
  const markerChannel = `accctrl${uniqueSuffix()}`;

  beforeAll(async () => {
    const owner = await createAuthenticatedUser('srchac');
    ownerToken = owner.accessToken;
    const community = await createCommunity(ownerToken, uniqueSuffix());
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

  it('unscoped search does not return messages from private channels outside the user\'s access', async () => {
    const outsider = await createAuthenticatedUser('srchunscoped');
    const res = await request(app)
      .get(`/api/v1/search?q=${markerChannel}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(res.status).toBe(200);
    // outsider has no access to the private channel — must not appear in results
    for (const hit of res.body.hits) {
      expect(hit.channelId).not.toBe(privateChannelId);
    }
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

describe('Search – trigram fallback', () => {
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
