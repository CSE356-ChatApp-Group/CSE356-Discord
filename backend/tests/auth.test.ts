/**
 * Auth route tests
 *
 * Run with: npm test
 * Requires a live Postgres and Redis (provided by docker-compose or the CI service config).
 */

'use strict';

const http = require('http');
const request = require('supertest');
const { randomUUID } = require('crypto');
const { WebSocket } = require('ws');
const app     = require('../src/app');
const wsServer = require('../src/websocket/server');
const { pool }= require('../src/db/pool');
const { closeRedisConnections } = require('../src/db/redis');

function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

async function registerUser({ email, username, password = 'Password1!', displayName }: { email: string; username: string; password?: string; displayName?: string }) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, username, password, displayName: displayName || username });

  return res;
}

async function createAuthenticatedUser(prefix) {
  const suffix = uniqueSuffix();
  const email = `${prefix}-${suffix}@example.com`;
  const username = `${prefix}${suffix}`.slice(0, 32);
  const res = await registerUser({ email, username });
  return {
    email,
    username,
    accessToken: res.body.accessToken,
    user: res.body.user,
  };
}

function startWebSocketTestServer() {
  const server = http.createServer(app);
  server.on('upgrade', wsServer.handleUpgrade);

  return new Promise<{ server: any; port: number }>((resolve) => {
    server.listen(0, () => {
      const address = server.address() as any;
      const port = Number(address?.port);
      resolve({ server, port });
    });
  });
}

function connectWebSocket(port, token) {
  return new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timed out connecting websocket'));
    }, 3000);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function closeWebSocket(ws) {
  return new Promise<void>((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', resolve);
    ws.close();
  });
}

function waitForWsEvent(ws, predicate, timeoutMs = 4000) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket event'));
    }, timeoutMs);

    const onMessage = (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!predicate(event)) return;

      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(event);
    };

    ws.on('message', onMessage);
  });
}

beforeAll(async () => {
  // Ensure test user doesn't exist
  await pool.query("DELETE FROM users WHERE email = 'test@example.com'");
});

afterAll(async () => {
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

describe('POST /api/v1/auth/register', () => {
  it('creates a new user and returns an access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', username: 'testuser', password: 'Password1!', displayName: 'Test User' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
  });

  it('rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', username: 'testuser2', password: 'Password1!' });

    expect(res.status).toBe(409);
  });

  it('rejects weak passwords', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'other@example.com', username: 'other', password: '123' });

    expect(res.status).toBe(400);
  });

  it('accepts hyphenated usernames and returns conflict on duplicate registration', async () => {
    const suffix = uniqueSuffix();
    const email = `hyphen-${suffix}@example.com`;
    const username = `abiding-aardwark-${suffix}`.slice(0, 32);

    const first = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, username, password: 'Password1!' });

    expect(first.status).toBe(201);
    expect(first.body.user.username).toBe(username);

    const duplicate = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, username, password: 'Password1!' });

    expect(duplicate.status).toBe(409);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns access token for valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    // refresh cookie should be set
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/users/me', () => {
  let token;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });
    token = res.body.accessToken;
  });

  it('returns own profile when authenticated', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('testuser');
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});

describe('Overload behavior', () => {
  let token;
  let userId;
  let channelId;

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });

    token = loginRes.body.accessToken;

    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      ['test@example.com']
    );
    userId = userRows[0].id;

    const slug = `loadtest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const { rows: communityRows } = await pool.query(
      `INSERT INTO communities (slug, name, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [slug, 'Load Test Community', userId]
    );
    const communityId = communityRows[0].id;

    await pool.query(
      `INSERT INTO community_members (community_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [communityId, userId]
    );

    const { rows: channelRows } = await pool.query(
      `INSERT INTO channels (community_id, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [communityId, `general-${Math.floor(Math.random() * 10000)}`, userId]
    );
    channelId = channelRows[0].id;
  });

  afterEach(() => {
    delete process.env.FORCE_OVERLOAD_STAGE;
  });

  it('keeps core message create path available under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: 'core path should still work' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.content).toBe('core path should still work');
  });

  it('rejects message edit under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .patch(`/api/v1/messages/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'updated' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });

  it('rejects message delete under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .delete(`/api/v1/messages/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });

  it('rejects read-state write under critical stage', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .put(`/api/v1/messages/${randomUUID()}/read`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily delayed/i);
  });

  it('rejects search at critical stage before query execution', async () => {
    process.env.FORCE_OVERLOAD_STAGE = '3';

    const res = await request(app)
      .get('/api/v1/search')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });
});

describe('Message hydration payloads', () => {
  let token;
  let userId;
  let channelId;

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1!' });

    token = loginRes.body.accessToken;

    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      ['test@example.com']
    );
    userId = userRows[0].id;

    const slug = `hydration-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const { rows: communityRows } = await pool.query(
      `INSERT INTO communities (slug, name, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [slug, 'Hydration Test Community', userId]
    );
    const communityId = communityRows[0].id;

    await pool.query(
      `INSERT INTO community_members (community_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [communityId, userId]
    );

    const { rows: channelRows } = await pool.query(
      `INSERT INTO channels (community_id, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [communityId, `hydration-${Math.floor(Math.random() * 10000)}`, userId]
    );
    channelId = channelRows[0].id;
  });

  it('returns hydrated author and attachments on message create', async () => {
    const res = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: 'hydrated create payload' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.author).toBeDefined();
    expect(res.body.message.author.id).toBe(userId);
    expect(Array.isArray(res.body.message.attachments)).toBe(true);
  });

  it('returns hydrated author and attachments on message update', async () => {
    const createRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ channelId, content: 'before edit' });

    const messageId = createRes.body.message.id;
    const res = await request(app)
      .patch(`/api/v1/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'after edit' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.content).toBe('after edit');
    expect(res.body.message.author).toBeDefined();
    expect(res.body.message.author.id).toBe(userId);
    expect(Array.isArray(res.body.message.attachments)).toBe(true);
  });
});

describe('DM management and realtime delivery', () => {
  let server;
  let port;

  beforeAll(async () => {
    const started = await startWebSocketTestServer();
    server = started.server;
    port = started.port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('keeps invited participants pending until acceptance, then allows them to leave', async () => {
    const userA = await createAuthenticatedUser('dmowner');
    const userB = await createAuthenticatedUser('dminitial');
    const userC = await createAuthenticatedUser('dminvite');

    const inviteeSocket = await connectWebSocket(port, userC.accessToken);

    try {
      const createRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ participantIds: [userB.user.id] });

      expect(createRes.status).toBe(201);
      const conversationId = createRes.body.conversation.id;

      const inviteEventPromise = waitForWsEvent(inviteeSocket, (event) => event.event === 'conversation:invited');

      const inviteRes = await request(app)
        .post(`/api/v1/conversations/${conversationId}/invite`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ participantIds: [userC.user.id] });

      expect(inviteRes.status).toBe(200);
      expect(inviteRes.body.addedParticipantIds).toContain(userC.user.id);

      const inviteEvent = await inviteEventPromise;
      // The invitee never explicitly subscribes to conversation/user channels in this test.
      // Receiving this event validates server-side auto subscription/notification wiring.
      expect(inviteEvent.data.conversationId).toBe(conversationId);
      expect(inviteEvent.data.participantIds).toContain(userC.user.id);
      expect(inviteEvent.data.invitedBy).toBe(userA.user.id);

      // Pending invitees should not be active participants yet.
      const pendingListRes = await request(app)
        .get('/api/v1/conversations')
        .set('Authorization', `Bearer ${userC.accessToken}`);

      expect(pendingListRes.status).toBe(200);
      expect(pendingListRes.body.conversations.find((conversation) => conversation.id === conversationId)).toBeUndefined();

      // Joining system message should not exist until the invitee accepts.
      const beforeAcceptMessages = await request(app)
        .get('/api/v1/messages')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .query({ conversationId });

      expect(beforeAcceptMessages.status).toBe(200);
      expect(
        beforeAcceptMessages.body.messages.some(
          (m) => m.type === 'system' && /joined the group\./i.test(m.content || '')
        )
      ).toBe(false);

      const acceptRes = await request(app)
        .post(`/api/v1/conversations/${conversationId}/accept`)
        .set('Authorization', `Bearer ${userC.accessToken}`)
        .send({});

      expect(acceptRes.status).toBe(200);

      const afterAcceptMessages = await request(app)
        .get('/api/v1/messages')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .query({ conversationId });

      expect(afterAcceptMessages.status).toBe(200);
      expect(
        afterAcceptMessages.body.messages.some(
          (m) => m.type === 'system' && /joined the group\./i.test(m.content || '')
        )
      ).toBe(true);

      const leaveRes = await request(app)
        .post(`/api/v1/conversations/${conversationId}/leave`)
        .set('Authorization', `Bearer ${userC.accessToken}`)
        .send({});

      expect(leaveRes.status).toBe(200);

      const listRes = await request(app)
        .get('/api/v1/conversations')
        .set('Authorization', `Bearer ${userC.accessToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.conversations.find((conversation) => conversation.id === conversationId)).toBeUndefined();
    } finally {
      await closeWebSocket(inviteeSocket);
    }
  });

  it('rejects accepting a conversation when user is not invited', async () => {
    const owner = await createAuthenticatedUser('dmacceptowner');
    const member = await createAuthenticatedUser('dmacceptmember');
    const stranger = await createAuthenticatedUser('dmacceptstranger');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [member.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const acceptRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/accept`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({});

    expect(acceptRes.status).toBe(403);
    expect(acceptRes.body.error).toMatch(/not invited/i);
  });

  it('accept endpoint is idempotent and emits joined system message only once', async () => {
    const owner = await createAuthenticatedUser('dmacceptonceowner');
    const existing = await createAuthenticatedUser('dmacceptonceexisting');
    const invitee = await createAuthenticatedUser('dmacceptonceinvitee');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [existing.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const inviteRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/invite`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [invitee.user.id] });

    expect(inviteRes.status).toBe(200);

    const firstAccept = await request(app)
      .post(`/api/v1/conversations/${conversationId}/accept`)
      .set('Authorization', `Bearer ${invitee.accessToken}`)
      .send({});

    expect(firstAccept.status).toBe(200);

    const secondAccept = await request(app)
      .post(`/api/v1/conversations/${conversationId}/accept`)
      .set('Authorization', `Bearer ${invitee.accessToken}`)
      .send({});

    expect(secondAccept.status).toBe(200);

    const messagesRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .query({ conversationId });

    expect(messagesRes.status).toBe(200);
    const joinedMessages = messagesRes.body.messages.filter(
      (m) => m.type === 'system' && /joined the group\./i.test(m.content || '') && /invitee/i.test(m.content || '')
    );
    expect(joinedMessages).toHaveLength(1);
  });

  it('emits joined system message when first invitee accepts in a group-intent conversation', async () => {
    const owner = await createAuthenticatedUser('dmgroupintentowner');
    const inviteeA = await createAuthenticatedUser('dmgroupintenta');
    const inviteeB = await createAuthenticatedUser('dmgroupintentb');

    // Start from 1:1, then invite a second pending member so the conversation is group-intent (3 total members).
    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [inviteeA.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const inviteSecondRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/invite`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [inviteeB.user.id] });

    expect(inviteSecondRes.status).toBe(200);

    const acceptRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/accept`)
      .set('Authorization', `Bearer ${inviteeB.accessToken}`)
      .send({});

    expect(acceptRes.status).toBe(200);

    const messagesRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .query({ conversationId });

    expect(messagesRes.status).toBe(200);
    const joinedMessages = messagesRes.body.messages.filter(
      (m) => m.type === 'system' && /joined the group\./i.test(m.content || '')
    );
    expect(joinedMessages).toHaveLength(1);
  });

  it('delivers DM message and read events on user websocket channels', async () => {
    const sender = await createAuthenticatedUser('dmsender');
    const recipient = await createAuthenticatedUser('dmrecipient');

    const senderSocket = await connectWebSocket(port, sender.accessToken);
    const recipientSocket = await connectWebSocket(port, recipient.accessToken);

    try {
      const createConversationRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ participantIds: [recipient.user.id] });

      expect(createConversationRes.status).toBe(201);
      const conversationId = createConversationRes.body.conversation.id;

      const createdEventPromise = waitForWsEvent(
        recipientSocket,
        (event) => event.event === 'message:created' && event.data?.conversation_id === conversationId
      );

      const createMessageRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: 'hello realtime' });

      expect(createMessageRes.status).toBe(201);
      const messageId = createMessageRes.body.message.id;
      const createdEvent = await createdEventPromise;
      expect(createdEvent.data.id).toBe(messageId);

      const updatedEventPromise = waitForWsEvent(
        recipientSocket,
        (event) => event.event === 'message:updated' && event.data?.id === messageId
      );

      const updateRes = await request(app)
        .patch(`/api/v1/messages/${messageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ content: 'hello edited realtime' });

      expect(updateRes.status).toBe(200);
      const updatedEvent = await updatedEventPromise;
      expect(updatedEvent.data.content).toBe('hello edited realtime');

      const deletedEventPromise = waitForWsEvent(
        recipientSocket,
        (event) => event.event === 'message:deleted' && event.data?.id === messageId
      );

      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${messageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`);

      expect(deleteRes.status).toBe(200);
      await deletedEventPromise;

      const secondMessageRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: 'mark read target' });

      expect(secondMessageRes.status).toBe(201);
      const secondMessageId = secondMessageRes.body.message.id;

      const readEventPromise = waitForWsEvent(
        senderSocket,
        (event) => event.event === 'read:updated' && event.data?.lastReadMessageId === secondMessageId
      );

      const readRes = await request(app)
        .put(`/api/v1/messages/${secondMessageId}/read`)
        .set('Authorization', `Bearer ${recipient.accessToken}`);

      expect(readRes.status).toBe(200);
      const readEvent = await readEventPromise;
      expect(readEvent.data.userId).toBe(recipient.user.id);
      expect(readEvent.data.conversationId).toBe(conversationId);
    } finally {
      await closeWebSocket(senderSocket);
      await closeWebSocket(recipientSocket);
    }
  });

  it('delivers channel messages without manual websocket subscribe', async () => {
    const owner = await createAuthenticatedUser('wsautosubowner');
    const member = await createAuthenticatedUser('wsautosubmember');

    const slug = `ws-auto-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'ws auto subscribe test' });

    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({});

    expect(joinRes.status).toBe(200);

    const channelName = `auto-sub-${uniqueSuffix()}`;
    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: channelName, isPrivate: false, description: 'auto-sub channel' });

    expect(channelRes.status).toBe(201);
    const channelId = channelRes.body.channel.id;

    const memberSocket = await connectWebSocket(port, member.accessToken);

    try {
      // Do not send a subscribe frame here; this validates server-side bootstrap subscriptions.
      const createdEventPromise = waitForWsEvent(
        memberSocket,
        (event) => event.event === 'message:created' && event.data?.channel_id === channelId
      );

      const sendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: 'channel ws auto-sub check' });

      expect(sendRes.status).toBe(201);
      const event = await createdEventPromise;
      expect(event.data.content).toBe('channel ws auto-sub check');
    } finally {
      await closeWebSocket(memberSocket);
    }
  });

  it('blocks DM edits, deletes, and read receipts after a participant leaves', async () => {
    const owner = await createAuthenticatedUser('dmguardowner');
    const participant = await createAuthenticatedUser('dmguardparticipant');
    const third = await createAuthenticatedUser('dmguardthird');

    // Use a group DM (3 people) so the conversation is NOT deleted when participant leaves.
    // This lets us verify that the leaving participant is properly blocked.
    const createConversationRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [participant.user.id, third.user.id] });

    expect(createConversationRes.status).toBe(201);
    const conversationId = createConversationRes.body.conversation.id;

    const participantMessageRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .send({ conversationId, content: 'message before leaving' });

    expect(participantMessageRes.status).toBe(201);
    const participantMessageId = participantMessageRes.body.message.id;

    const ownerMessageRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ conversationId, content: 'owner message after join' });

    expect(ownerMessageRes.status).toBe(201);
    const ownerMessageId = ownerMessageRes.body.message.id;

    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .send({});

    expect(leaveRes.status).toBe(200);

    const editRes = await request(app)
      .patch(`/api/v1/messages/${participantMessageId}`)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .send({ content: 'edited after leaving' });

    expect(editRes.status).toBe(403);
    expect(editRes.body.error).toMatch(/access denied/i);

    const deleteRes = await request(app)
      .delete(`/api/v1/messages/${participantMessageId}`)
      .set('Authorization', `Bearer ${participant.accessToken}`);

    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.error).toMatch(/access denied/i);

    const readRes = await request(app)
      .put(`/api/v1/messages/${ownerMessageId}/read`)
      .set('Authorization', `Bearer ${participant.accessToken}`);

    expect(readRes.status).toBe(403);
    expect(readRes.body.error).toMatch(/access denied/i);
  });

  it('deletes 1:1 DM for both parties when one participant leaves', async () => {
    const userA = await createAuthenticatedUser('dm1to1a');
    const userB = await createAuthenticatedUser('dm1to1b');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ participantIds: [userB.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    // userA leaves the 1:1 DM
    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({});

    expect(leaveRes.status).toBe(200);

    // The conversation should also be gone for userB
    const listResB = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userB.accessToken}`);

    expect(listResB.status).toBe(200);
    expect(listResB.body.conversations.find((c) => c.id === conversationId)).toBeUndefined();

    // userA also should not see it
    const listResA = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(listResA.status).toBe(200);
    expect(listResA.body.conversations.find((c) => c.id === conversationId)).toBeUndefined();
  });

  it('retains group DM history for remaining participants when one leaves', async () => {
    const userA = await createAuthenticatedUser('dmgroup3a');
    const userB = await createAuthenticatedUser('dmgroup3b');
    const userC = await createAuthenticatedUser('dmgroup3c');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ participantIds: [userB.user.id, userC.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    // userA sends a message then leaves
    await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ conversationId, content: 'farewell message' });

    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({});

    expect(leaveRes.status).toBe(200);

    // userB and userC should still see the conversation
    const listResB = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userB.accessToken}`);

    expect(listResB.status).toBe(200);
    expect(listResB.body.conversations.find((c) => c.id === conversationId)).toBeDefined();

    const listResC = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userC.accessToken}`);

    expect(listResC.status).toBe(200);
    expect(listResC.body.conversations.find((c) => c.id === conversationId)).toBeDefined();
  });

  it('persists leave system message in group DM history for remaining participants', async () => {
    const userA = await createAuthenticatedUser('dmsysleavea');
    const userB = await createAuthenticatedUser('dmsysleaveb');
    const userC = await createAuthenticatedUser('dmsysleavec');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ participantIds: [userB.user.id, userC.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({});

    expect(leaveRes.status).toBe(200);

    const messagesRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .query({ conversationId });

    expect(messagesRes.status).toBe(200);

    const leaveMessage = messagesRes.body.messages.find(
      (m) => m.type === 'system' && /left the group\./i.test(m.content || '')
    );

    expect(leaveMessage).toBeDefined();
    expect(leaveMessage.author_id).toBeNull();
    expect(leaveMessage.author).toBeNull();
  });

  it('emits realtime system message when a participant leaves a group DM', async () => {
    const owner = await createAuthenticatedUser('dmrtleaveowner');
    const leaver = await createAuthenticatedUser('dmrtleaver');
    const third = await createAuthenticatedUser('dmrtleavethird');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [leaver.user.id, third.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const { server, port } = await startWebSocketTestServer();
    const ownerSocket = await connectWebSocket(port, owner.accessToken);

    try {
      ownerSocket.send(JSON.stringify({ type: 'subscribe', channel: `conversation:${conversationId}` }));
      await waitForWsEvent(
        ownerSocket,
        (event) => event.event === 'subscribed' && event.data?.channel === `conversation:${conversationId}`
      );

      const leaveSystemMessagePromise = waitForWsEvent(
        ownerSocket,
        (event) => (
          event.event === 'message:created'
          && event.data?.conversation_id === conversationId
          && event.data?.type === 'system'
          && /left the group\./i.test(event.data?.content || '')
        )
      );

      const leaveRes = await request(app)
        .post(`/api/v1/conversations/${conversationId}/leave`)
        .set('Authorization', `Bearer ${leaver.accessToken}`)
        .send({});

      expect(leaveRes.status).toBe(200);

      const leaveMessageEvent = await leaveSystemMessagePromise;
      expect(leaveMessageEvent.data.author_id).toBeNull();
    } finally {
      await closeWebSocket(ownerSocket);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
