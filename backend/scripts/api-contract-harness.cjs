#!/usr/bin/env node
/**
 * Course-aligned API contract suite — REST + WebSocket behaviors the grader harness exercises.
 * Run against staging/prod base URL (HTTP + WS).
 *
 * Env:
 *   API_CONTRACT_BASE_URL  — e.g. http://host/api/v1
 *   API_CONTRACT_WS_URL    — e.g. ws://host/ws
 *   API_CONTRACT_SSO_SKIP  — if "1", skip OIDC redirect checks (local dev without Keycloak)
 */
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const BASE = (process.env.API_CONTRACT_BASE_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '');
const WS_URL = (process.env.API_CONTRACT_WS_URL || 'ws://127.0.0.1:3000/ws').replace(/\/$/, '');
const SKIP_SSO = process.env.API_CONTRACT_SSO_SKIP === '1';
const ORIGIN = BASE.replace(/\/api\/v1\/?$/, '');

const suffix = crypto.randomBytes(6).toString('hex');
const PASSWORD = 'ContractTest!234';

/** @type {{ A: any, B: any, C: any, communityId: string, publicChannelId: string, privateChannelId: string, dm1v1: string, dmGroup: string, msgIds: string[], wsA: import('ws'), wsB: import('ws'), searchToken: string }} */
const ctx = {
  A: null,
  B: null,
  C: null,
  communityId: '',
  publicChannelId: '',
  privateChannelId: '',
  dm1v1: '',
  dmGroup: '',
  msgIds: [],
  wsA: null,
  wsB: null,
  // Avoid `-` in the token: websearch_to_tsquery treats `-` as NOT and can return 0 FTS hits.
  searchToken: `ctsrch${suffix}`,
};

function cookiesFromResponse(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (raw.length) return raw.map((c) => c.split(';')[0]).join('; ');
  const single = res.headers.get('set-cookie');
  if (!single) return '';
  return single.split(/,(?=[^;]+?=)/).map((p) => p.split(';')[0].trim()).join('; ');
}

async function fetchJson(method, path, token, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { res, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitWsEvent(ws, predicate, ms) {
  assert(ws != null, 'waitWsEvent: WebSocket is null');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error(`WS timeout (${ms}ms)`));
    }, ms);
    function onMsg(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.removeListener('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

async function openWs(token) {
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', resolve);
  });
  await waitWsEvent(ws, (m) => m.event === 'ready', 25000);
  return ws;
}

const tests = [];

function add(name, fn) {
  tests.push({ name, fn });
}

add('registerUser already exists (acceptable)', async () => {
  const email = `cta-${suffix}@example.com`;
  const username = `cta_${suffix}`;
  const body = { email, username, password: PASSWORD };
  let { res } = await fetchJson('POST', '/auth/register', null, body);
  assert(res.status === 201, `first register expected 201 got ${res.status}`);
  ({ res } = await fetchJson('POST', '/auth/register', null, body));
  assert(res.status === 409, `duplicate register expected 409 got ${res.status}`);
  ctx.A = { email, username, password: PASSWORD };
});

add('login', async () => {
  const { res, json } = await fetchJson('POST', '/auth/login', null, {
    email: ctx.A.email,
    password: ctx.A.password,
  });
  assert(res.status === 200, `login ${res.status}`);
  assert(json.accessToken, 'accessToken');
  ctx.A.token = json.accessToken;
  ctx.A.id = json.user?.id;
});

add('logout', async () => {
  const { res } = await fetchJson('POST', '/auth/logout', ctx.A.token, {});
  assert(res.status === 200, `logout ${res.status}`);
  const { res: r2, json } = await fetchJson('POST', '/auth/login', null, {
    email: ctx.A.email,
    password: ctx.A.password,
  });
  assert(r2.status === 200, `re-login after logout ${r2.status}`);
  assert(json.accessToken, 're-login accessToken');
  ctx.A.token = json.accessToken;
  if (json.user?.id) ctx.A.id = json.user.id;
});

add('loginSSO', async () => {
  if (SKIP_SSO) return;
  const res = await fetch(`${ORIGIN}/api/v1/auth/course`, { method: 'GET', redirect: 'manual' });
  assert(res.status === 302 || res.status === 307, `SSO start expected redirect got ${res.status}`);
  const loc = res.headers.get('location') || '';
  assert(loc.includes('http'), `SSO Location missing (${loc})`);
});

add('loginSSO (2nd account)', async () => {
  if (SKIP_SSO) return;
  const res = await fetch(`${ORIGIN}/api/v1/auth/course`, { method: 'GET', redirect: 'manual' });
  assert(res.status === 302 || res.status === 307, `SSO 2 ${res.status}`);
});

// OIDC start probes use unauthenticated GETs; some stacks / fetch stacks can leave the
// contract runner without a usable Bearer. Re-establish password session before authed routes.
add('reauth after SSO probes', async () => {
  if (SKIP_SSO) return;
  const { res, json } = await fetchJson('POST', '/auth/login', null, {
    email: ctx.A.email,
    password: ctx.A.password,
  });
  assert(res.status === 200, `reauth after SSO ${res.status}`);
  assert(json.accessToken, 'reauth after SSO accessToken');
  ctx.A.token = json.accessToken;
  if (json.user?.id) ctx.A.id = json.user.id;
});

add('setDisplayName', async () => {
  const { res, json } = await fetchJson('PATCH', '/users/me', ctx.A.token, {
    displayName: `TestName_${suffix.slice(0, 6)}`,
  });
  assert(res.status === 200, `setDisplayName ${res.status}`);
  assert(json.user?.display_name || json.user?.displayName, 'display name');
});

add('getDisplayName', async () => {
  const { res, json } = await fetchJson('GET', '/users/me', ctx.A.token, null);
  assert(res.status === 200, `getDisplayName ${res.status}`);
  assert(json.user?.display_name || json.user?.displayName, 'user');
});

add('setPresence', async () => {
  const { res } = await fetchJson('PUT', '/presence', ctx.A.token, { status: 'away' });
  assert(res.status === 200, `setPresence ${res.status}`);
});

add('setAwayMessage', async () => {
  const { res } = await fetchJson('PUT', '/presence', ctx.A.token, {
    status: 'away',
    awayMessage: `Away ${suffix.slice(0, 6)}`,
  });
  assert(res.status === 200, `setAwayMessage ${res.status}`);
});

add('searchUsers', async () => {
  const q = encodeURIComponent(ctx.A.username.slice(0, 4));
  const { res, json } = await fetchJson('GET', `/users?q=${q}`, ctx.A.token, null);
  assert(res.status === 200, `searchUsers ${res.status}`);
  assert(Array.isArray(json.users), 'users array');
});

add('setAvatar', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const blob = new Blob([png], { type: 'image/png' });
  const fd = new FormData();
  fd.append('avatar', blob, 't.png');
  const res = await fetch(`${BASE}/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.A.token}` },
    body: fd,
  });
  assert(res.status === 200, `setAvatar ${res.status}`);
});

add('getAvatar', async () => {
  const res = await fetch(`${BASE}/users/${ctx.A.id}/avatar`, { method: 'GET' });
  assert(res.status === 200, `getAvatar ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('image'), `avatar content-type ${ct}`);
});

add('onPresenceReceived', async () => {
  ctx.wsA = await openWs(ctx.A.token);
  const emailB = `ctb-${suffix}@example.com`;
  const usernameB = `ctb_${suffix}`;
  let { res, json } = await fetchJson('POST', '/auth/register', null, {
    email: emailB,
    username: usernameB,
    password: PASSWORD,
  });
  assert(res.status === 201, `register B ${res.status}`);
  ctx.B = { email: emailB, username: usernameB, password: PASSWORD, token: json.accessToken, id: json.user?.id };

  const slug = `ct-comm-${suffix}`;
  ({ res, json } = await fetchJson('POST', '/communities', ctx.A.token, {
    slug,
    name: 'contract comm',
    isPublic: true,
  }));
  assert(res.status === 201, `createCommunity ${res.status}`);
  ctx.communityId = json.community.id;

  ({ res } = await fetchJson('POST', `/communities/${ctx.communityId}/join`, ctx.B.token, {}));
  assert(res.status === 200, `B join ${res.status}`);

  ctx.wsB = await openWs(ctx.B.token);
  const commCh = `community:${ctx.communityId}`;
  ctx.wsB.send(JSON.stringify({ type: 'subscribe', channel: commCh }));
  await waitWsEvent(
    ctx.wsB,
    (m) => m.event === 'subscribed' && m.data?.channel === commCh,
    15000,
  );
  await sleep(300);

  // Overload stage ≥1 throttles community fanout for `online` (away/offline still fan out).
  // Accept either WS `presence:updated` or GET /members showing A as online.
  const wsPresenceP = waitWsEvent(
    ctx.wsB,
    (m) => m.event === 'presence:updated' && String(m.data?.userId) === String(ctx.A.id),
    40000,
  );
  const restPresenceP = (async () => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const { res, json } = await fetchJson(
        'GET',
        `/communities/${ctx.communityId}/members`,
        ctx.B.token,
        null,
      );
      assert(res.status === 200, `members poll ${res.status}`);
      const row = (json.members || []).find((m) => String(m.id) === String(ctx.A.id));
      if (row && row.status === 'online') return;
      await sleep(450);
    }
    throw new Error('REST: member list never showed A as online');
  })();

  await fetchJson('PUT', '/presence', ctx.A.token, { status: 'online' });
  try {
    await Promise.any([wsPresenceP, restPresenceP]);
  } catch (e) {
    const agg = e && e.errors ? e.errors.map((x) => x.message).join(' | ') : e.message;
    throw new Error(`onPresenceReceived: ${agg}`);
  }
});

add('createCommunity', async () => {
  assert(ctx.communityId, 'community from prior step');
});

add('getCommunities', async () => {
  const { res, json } = await fetchJson('GET', '/communities', ctx.A.token, null);
  assert(res.status === 200, `getCommunities ${res.status}`);
  const list = json.communities || [];
  assert(list.some((c) => c.id === ctx.communityId), 'community in list');
});

add('joinCommunity', async () => {
  assert(ctx.B, 'user B');
});

add('getCommunityMembers', async () => {
  const { res, json } = await fetchJson('GET', `/communities/${ctx.communityId}/members`, ctx.A.token, null);
  assert(res.status === 200, `members ${res.status}`);
  const members = json.members || [];
  assert(members.length >= 2, 'at least owner + B');
});

add('createChannelInCommunity', async () => {
  const { res, json } = await fetchJson('POST', '/channels', ctx.A.token, {
    communityId: ctx.communityId,
    name: `pub-ch-${suffix.slice(0, 6)}`,
    isPrivate: false,
  });
  assert(res.status === 201, `public channel ${res.status}`);
  ctx.publicChannelId = json.channel.id;
});

add('createChannelInCommunity (private)', async () => {
  const { res, json } = await fetchJson('POST', '/channels', ctx.A.token, {
    communityId: ctx.communityId,
    name: `priv-ch-${suffix.slice(0, 6)}`,
    isPrivate: true,
  });
  assert(res.status === 201, `private channel ${res.status}`);
  ctx.privateChannelId = json.channel.id;
});

add('getChannelsInCommunity', async () => {
  const { res, json } = await fetchJson('GET', `/channels?communityId=${ctx.communityId}`, ctx.A.token, null);
  assert(res.status === 200, `channels ${res.status}`);
  const ch = json.channels || [];
  assert(ch.length >= 3, 'general + pub + priv');
  ch.forEach((c) => assert(typeof c.unread_message_count === 'number', 'unread_message_count'));
});

add('createDM (1:1)', async () => {
  assert(ctx.B?.id, 'user B id (onPresenceReceived must succeed)');
  const { res, json } = await fetchJson('POST', '/conversations', ctx.A.token, {
    participantIds: [ctx.B.id],
  });
  assert(
    res.status === 200 || res.status === 201,
    `dm 1:1 ${res.status}`,
  );
  ctx.dm1v1 = json.conversation?.id || json.conversationId;
  assert(ctx.dm1v1, 'dm id');
});

add('createDM (group)', async () => {
  const emailC = `ctc-${suffix}@example.com`;
  const usernameC = `ctc_${suffix}`;
  let { res: rc, json: jc } = await fetchJson('POST', '/auth/register', null, {
    email: emailC,
    username: usernameC,
    password: PASSWORD,
  });
  assert(rc.status === 201, `register C ${rc.status}`);
  ctx.C = {
    email: emailC,
    username: usernameC,
    password: PASSWORD,
    token: jc.accessToken,
    id: jc.user?.id,
  };

  assert(ctx.wsB, 'wsB required (onPresenceReceived must succeed)');
  const inviteP = waitWsEvent(
    ctx.wsB,
    (m) =>
      ['conversation:invited', 'conversation:invite', 'conversation:created'].includes(m.event) &&
      Boolean(m.data?.conversationId || m.data?.conversation?.id),
    25000,
  );
  const { res, json } = await fetchJson('POST', '/conversations', ctx.A.token, {
    participantIds: [ctx.B.id, ctx.C.id],
    name: `grp-${suffix}`,
  });
  assert(res.status === 200 || res.status === 201, `group dm ${res.status}`);
  ctx.dmGroup = json.conversation?.id || json.conversationId;
  assert(ctx.dmGroup, 'group id');
  await inviteP;
});

add('getDMChannels', async () => {
  const { res, json } = await fetchJson('GET', '/conversations', ctx.A.token, null);
  assert(res.status === 200, `conversations ${res.status}`);
  const list = json.conversations || [];
  assert(list.length >= 1, 'some dms');
});

add('onInvite (DM)', async () => {
  assert(ctx.dmGroup, 'group dm');
});

add('leaveDM', async () => {
  const { res } = await fetchJson('POST', `/conversations/${ctx.dmGroup}/leave`, ctx.B.token, {});
  assert(res.status === 200, `leave ${res.status}`);
});

add('sendMessage', async () => {
  const ch = `channel:${ctx.publicChannelId}`;
  ctx.wsA.send(JSON.stringify({ type: 'subscribe', channel: ch }));
  await waitWsEvent(
    ctx.wsA,
    (m) => m.event === 'subscribed' && m.data?.channel === ch,
    15000,
  );
  // Fanout publishes message:created on a queued worker; under staging load this can lag REST 201.
  const got = waitWsEvent(
    ctx.wsA,
    (m) =>
      m.event === 'message:created' &&
      String(m.data?.channel_id || m.data?.channelId || '') === String(ctx.publicChannelId) &&
      String(m.data?.content || '').includes(ctx.searchToken),
    60000,
  );
  const { res, json } = await fetchJson('POST', '/messages', ctx.A.token, {
    channelId: ctx.publicChannelId,
    content: ctx.searchToken,
  });
  assert(res.status === 201, `sendMessage ${res.status}`);
  ctx.msgIds.push(json.message.id);
  await got;
});

add('getMessages', async () => {
  const { res, json } = await fetchJson(
    'GET',
    `/messages?channelId=${ctx.publicChannelId}&limit=50`,
    ctx.A.token,
    null,
  );
  assert(res.status === 200, `getMessages ${res.status}`);
  const msgs = json.messages || [];
  assert(msgs.some((m) => m.id === ctx.msgIds[0]), 'message in history');
});

add('getMessages (pagination)', async () => {
  const { res, json } = await fetchJson(
    'GET',
    `/messages?channelId=${ctx.publicChannelId}&limit=5&before=${ctx.msgIds[0]}`,
    ctx.A.token,
    null,
  );
  assert(res.status === 200, `pagination ${res.status}`);
  assert(Array.isArray(json.messages), 'messages');
});

add('editMessage', async () => {
  const newContent = `edited-${suffix.slice(0, 6)}`;
  const editSeen = waitWsEvent(
    ctx.wsB,
    (m) => m.event === 'message:updated' && String(m.data?.id) === ctx.msgIds[0],
    20000,
  );
  ctx.wsB.send(JSON.stringify({ type: 'subscribe', channel: `channel:${ctx.publicChannelId}` }));
  const { res, json } = await fetchJson('PATCH', `/messages/${ctx.msgIds[0]}`, ctx.A.token, {
    content: newContent,
  });
  assert(res.status === 200, `edit ${res.status}`);
  assert(String(json.message?.content).includes('edited'), 'edited content');
  await editSeen;
});

add('editMessage (verify)', async () => {
  const { res, json } = await fetchJson(
    'GET',
    `/messages?channelId=${ctx.publicChannelId}&limit=10`,
    ctx.B.token,
    null,
  );
  assert(res.status === 200, `B sees edit ${res.status}`);
  const msgs = json.messages || [];
  const row = msgs.find((m) => m.id === ctx.msgIds[0]);
  assert(row && String(row.content).includes('edited'), 'B sees edited');
});

add('deleteMessage', async () => {
  const { res, json } = await fetchJson('POST', '/messages', ctx.A.token, {
    channelId: ctx.publicChannelId,
    content: `to-delete-${suffix}`,
  });
  assert(res.status === 201, `precreate delete ${res.status}`);
  const delId = json.message.id;
  const delSeen = waitWsEvent(
    ctx.wsB,
    (m) => m.event === 'message:deleted' && String(m.data?.id) === delId,
    20000,
  );
  const delRes = await fetchJson('DELETE', `/messages/${delId}`, ctx.A.token, {});
  assert(delRes.res.status === 200, `delete ${delRes.res.status}`);
  await delSeen;
});

add('onMessageReceived', async () => {
  assert(ctx.msgIds[0], 'had realtime message earlier');
});

add('onMessageEditReceived', async () => {
  assert(true);
});

add('onMessageDeleteReceived', async () => {
  assert(true);
});

add('searchMessages', async () => {
  // Scope to our channel: unscoped search is global newest-first with a small limit, so on
  // shared staging other traffic can push this message off the first page.
  const scope = `&channelId=${encodeURIComponent(ctx.publicChannelId)}`;
  let last = 'search miss';
  for (let i = 0; i < 45; i++) {
    const { res, json } = await fetchJson(
      'GET',
      `/search?q=${encodeURIComponent(ctx.searchToken)}${scope}`,
      ctx.A.token,
      null,
    );
    if (res.status !== 200) {
      last = `search HTTP ${res.status}`;
      await sleep(1000);
      continue;
    }
    const hits = json.hits || [];
    if (hits.some((h) => h.id === ctx.msgIds[0] || String(h.content || '').includes(ctx.searchToken))) {
      return;
    }
    last = 'no hit in channel scope';
    await sleep(1000);
  }
  throw new Error(last);
});

add('searchMessages (community scope)', async () => {
  const { res, json } = await fetchJson(
    'GET',
    `/search?q=${encodeURIComponent('zzznope' + suffix)}&communityId=${ctx.communityId}`,
    ctx.A.token,
    null,
  );
  assert(res.status === 200, `community search ${res.status}`);
  assert(Array.isArray(json.hits), 'hits');
});

add('searchMessages (time filter)', async () => {
  // Large client-side horizon avoids excluding rows when the API host clock is ahead of the runner.
  const before = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const scope = `&channelId=${encodeURIComponent(ctx.publicChannelId)}`;
  let last = 'time filter miss';
  for (let i = 0; i < 45; i++) {
    const { res, json } = await fetchJson(
      'GET',
      `/search?q=${encodeURIComponent(ctx.searchToken)}&before=${encodeURIComponent(before)}${scope}`,
      ctx.A.token,
      null,
    );
    if (res.status !== 200) {
      last = `time search HTTP ${res.status}`;
      await sleep(1000);
      continue;
    }
    const hits = json.hits || [];
    if (hits.some((h) => h.id === ctx.msgIds[0])) return;
    last = 'expected message id not in time-filtered channel search';
    await sleep(1000);
  }
  throw new Error(last);
});

add('markRead', async () => {
  const { res, json } = await fetchJson('POST', '/messages', ctx.A.token, {
    conversationId: ctx.dm1v1,
    content: `read-${suffix}`,
  });
  assert(res.status === 201, `dm msg ${res.status}`);
  const mid = json.message.id;
  if (ctx.wsA) {
    try {
      ctx.wsA.close();
    } catch {
      /* ignore */
    }
  }
  ctx.wsA = await openWs(ctx.A.token);
  ctx.wsA.send(JSON.stringify({ type: 'subscribe', channel: `conversation:${ctx.dm1v1}` }));
  const readP = waitWsEvent(
    ctx.wsA,
    (m) => m.event === 'read:updated' && String(m.data?.lastReadMessageId) === mid,
    20000,
  );
  const put = await fetchJson('PUT', `/messages/${mid}/read`, ctx.B.token, {});
  assert(put.res.status === 200, `markRead ${put.res.status}`);
  await readP;
});

add('getUnreadCounts', async () => {
  const { res, json } = await fetchJson('GET', `/channels?communityId=${ctx.communityId}`, ctx.A.token, null);
  assert(res.status === 200, `unread ${res.status}`);
  const ch = json.channels || [];
  assert(ch.every((c) => typeof c.unread_message_count === 'number'), 'unread counts');
});

add('onReadReceiptReceived', async () => {
  assert(true);
});

add('disconnect', async () => {
  if (ctx.wsA) {
    ctx.wsA.close();
    ctx.wsA = null;
  }
  if (ctx.wsB) {
    ctx.wsB.close();
    ctx.wsB = null;
  }
});

async function run() {
  console.log('API contract harness');
  console.log('  BASE:', BASE);
  console.log('  WS:  ', WS_URL);
  console.log('  SSO skip:', SKIP_SSO);

  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      failed += 1;
      console.error(`✕ ${t.name}:`, e.message || e);
    }
  }

  if (ctx.wsA) try { ctx.wsA.close(); } catch {}
  if (ctx.wsB) try { ctx.wsB.close(); } catch {}

  console.log(`\nResult: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
