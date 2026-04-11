/**
 * Grader-parity integration tests.
 *
 * These tests mirror the external API checker's high-level flows so we can
 * detect grading regressions locally before submission.
 */

import http from 'http';
import { request, app, wsServer, pool, closeRedisConnections } from './runtime';
import {
  uniqueSuffix,
  createAuthenticatedUser,
  connectWebSocket,
  closeWebSocket,
  waitForWsEvent,
} from './helpers';

let server: any;
let port: number;
const openSockets: any[] = [];

function trackSocket(ws: any) {
  openSockets.push(ws);
  return ws;
}

function expectConversationId(res: any) {
  expect([200, 201]).toContain(res.status);
  expect(res.body?.conversation?.id).toBeDefined();
  return res.body.conversation.id as string;
}

beforeAll(async () => {
  server = http.createServer(app);
  server.on('upgrade', wsServer.handleUpgrade);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
  await wsServer.shutdown();
  await closeRedisConnections();
  await pool.end();
});

afterEach(async () => {
  while (openSockets.length) {
    const ws = openSockets.pop();
    try {
      await closeWebSocket(ws);
    } catch {
      // Ignore cleanup errors to avoid masking assertion failures.
    }
  }
});

describe('Grader parity: profile & presence', () => {
  it('updates display name, searches users, and emits presence updates', async () => {
    const userA = await createAuthenticatedUser('graderprofilea');
    const userB = await createAuthenticatedUser('graderprofileb');

    const newDisplayName = `TestName_${uniqueSuffix()}`;
    const patchRes = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ displayName: newDisplayName });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.user.display_name).toBe(newDisplayName);

    const meRes = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.display_name).toBe(newDisplayName);

    const searchRes = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .query({ q: 'graderprofile', limit: 20 });

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.users.some((u: any) => u.id === userA.user.id)).toBe(true);
    expect(searchRes.body.users.some((u: any) => u.id === userB.user.id)).toBe(true);

    const observerSocket = trackSocket(await connectWebSocket(port, userA.accessToken));
    try {
      observerSocket.send(JSON.stringify({ type: 'subscribe', channel: `user:${userA.user.id}` }));
      await waitForWsEvent(
        observerSocket,
        (event) => event.event === 'subscribed' && event.data?.channel === `user:${userA.user.id}`,
      );

      const presenceEventPromise = waitForWsEvent(
        observerSocket,
        (event) =>
          event.event === 'presence:updated'
          && event.data?.userId === userA.user.id
          && event.data?.status === 'away',
      );

      const setPresenceRes = await request(app)
        .put('/api/v1/presence')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ status: 'away', awayMessage: 'Away for grader parity test' });

      expect(setPresenceRes.status).toBe(200);

      const bulkPresenceRes = await request(app)
        .get('/api/v1/presence')
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .query({ userIds: userA.user.id });

      expect(bulkPresenceRes.status).toBe(200);
      expect(bulkPresenceRes.body.presence[userA.user.id]).toBe('away');

      const presenceEvent = await presenceEventPromise;
      expect(presenceEvent.data.status).toBe('away');
    } finally {
      // Closed by afterEach cleanup.
    }
  });
});

describe('Grader parity: communities and channels', () => {
  it('creates community, joins, lists members, creates channels, and lists channels', async () => {
    const owner = await createAuthenticatedUser('gradercommowner');
    const member = await createAuthenticatedUser('gradercommmember');

    const slug = `test-comm-${uniqueSuffix()}`;
    const createCommunityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'grader parity community' });

    expect(createCommunityRes.status).toBe(201);
    const communityId = createCommunityRes.body.community.id;

    const listRes = await request(app)
      .get('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.communities.some((c: any) => c.id === communityId)).toBe(true);

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({});

    expect(joinRes.status).toBe(200);

    const membersRes = await request(app)
      .get(`/api/v1/communities/${communityId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(membersRes.status).toBe(200);
    expect(membersRes.body.members.some((m: any) => m.id === owner.user.id)).toBe(true);
    expect(membersRes.body.members.some((m: any) => m.id === member.user.id)).toBe(true);

    const publicChannelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `pub-${uniqueSuffix()}`, isPrivate: false, description: 'public channel' });

    expect(publicChannelRes.status).toBe(201);

    const privateChannelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ communityId, name: `priv-${uniqueSuffix()}`, isPrivate: true, description: 'private channel' });

    expect(privateChannelRes.status).toBe(201);

    const channelsRes = await request(app)
      .get('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .query({ communityId });

    expect(channelsRes.status).toBe(200);
    const ids = channelsRes.body.channels.map((ch: any) => ch.id);
    expect(ids).toContain(publicChannelRes.body.channel.id);
    expect(ids).toContain(privateChannelRes.body.channel.id);

    const privateMessageRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId: privateChannelRes.body.channel.id, content: `private-${uniqueSuffix()}` });
    expect(privateMessageRes.status).toBe(201);

    const memberChannelsRes = await request(app)
      .get('/api/v1/channels')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .query({ communityId });

    expect(memberChannelsRes.status).toBe(200);
    const memberPrivate = memberChannelsRes.body.channels.find((ch: any) => ch.id === privateChannelRes.body.channel.id);
    expect(memberPrivate).toBeDefined();
    expect(memberPrivate.can_access).toBe(false);
    expect(memberPrivate.last_message_id).toBeNull();

    const memberPrivateHistoryRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .query({ channelId: privateChannelRes.body.channel.id });
    expect(memberPrivateHistoryRes.status).toBe(403);

    const invitePrivateMemberRes = await request(app)
      .post(`/api/v1/channels/${privateChannelRes.body.channel.id}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userIds: [member.user.id] });
    expect(invitePrivateMemberRes.status).toBe(200);
    expect(invitePrivateMemberRes.body.addedUserIds).toContain(member.user.id);

    const invitedMemberChannelsRes = await request(app)
      .get('/api/v1/channels')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .query({ communityId });
    expect(invitedMemberChannelsRes.status).toBe(200);
    const invitedPrivate = invitedMemberChannelsRes.body.channels.find((ch: any) => ch.id === privateChannelRes.body.channel.id);
    expect(invitedPrivate.can_access).toBe(true);

    const invitedPrivateHistoryRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .query({ channelId: privateChannelRes.body.channel.id });
    expect(invitedPrivateHistoryRes.status).toBe(200);
  });

  it('allows owners to delete communities and rejects non-owner deletion attempts', async () => {
    const owner = await createAuthenticatedUser('gradercommdeleteowner');
    const member = await createAuthenticatedUser('gradercommdeletemember');

    const slug = `delete-comm-${uniqueSuffix()}`;
    const createCommunityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'delete community parity test' });

    expect(createCommunityRes.status).toBe(201);
    const communityId = createCommunityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({});
    expect(joinRes.status).toBe(200);

    const memberDeleteRes = await request(app)
      .delete(`/api/v1/communities/${communityId}`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(memberDeleteRes.status).toBe(403);

    const ownerDeleteRes = await request(app)
      .delete(`/api/v1/communities/${communityId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ownerDeleteRes.status).toBe(200);

    const ownerListRes = await request(app)
      .get('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ownerListRes.status).toBe(200);
    expect(ownerListRes.body.communities.some((community: any) => community.id === communityId)).toBe(false);

    const memberListRes = await request(app)
      .get('/api/v1/communities')
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(memberListRes.status).toBe(200);
    expect(memberListRes.body.communities.some((community: any) => community.id === communityId)).toBe(false);
  });
});

describe('Grader parity: DM invite realtime', () => {
  it('delivers conversation:invited to a user added to an existing group DM', async () => {
    const owner = await createAuthenticatedUser('graderdmowner');
    const existing = await createAuthenticatedUser('graderdmexisting');
    const base = await createAuthenticatedUser('graderdmbase');
    const invitee = await createAuthenticatedUser('graderdminvitee');

    const inviteeSocket = trackSocket(await connectWebSocket(port, invitee.accessToken));
    try {
      const createDmRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [existing.user.id, base.user.id] });

      const groupConversationId = expectConversationId(createDmRes);

      const inviteEventPromise = waitForWsEvent(
        inviteeSocket,
        (event) => event.event === 'conversation:invited',
      );

      const inviteRes = await request(app)
        .post(`/api/v1/conversations/${groupConversationId}/invite`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [invitee.user.id] });

      expect(inviteRes.status).toBe(200);
      const conversationId = inviteRes.body.conversation.id;
      expect(inviteRes.body.addedParticipantIds).toContain(invitee.user.id);

      const inviteEvent = await inviteEventPromise;
      expect(inviteEvent.data.conversationId).toBe(conversationId);
      expect(inviteEvent.data.invitedBy).toBe(owner.user.id);
      expect(inviteEvent.data.participantIds).toContain(invitee.user.id);
    } finally {
      // Closed by afterEach cleanup.
    }
  });
});

describe('Grader parity: messaging, search, and read state', () => {
  it('supports message lifecycle, pagination, search filters, and read receipts', async () => {
    const sender = await createAuthenticatedUser('gradermsgsender');
    const recipient = await createAuthenticatedUser('gradermsgrecipient');

    const senderSocket = trackSocket(await connectWebSocket(port, sender.accessToken));
    try {
      const dmRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ participantIds: [recipient.user.id] });

      const conversationId = expectConversationId(dmRes);

      const term = `msg-${uniqueSuffix()}`;
      const sendRes1 = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: `${term}-one` });
      expect(sendRes1.status).toBe(201);

      const sendRes2 = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: `${term}-two` });
      expect(sendRes2.status).toBe(201);
      const latestMessageId = sendRes2.body.message.id;

      const historyRes = await request(app)
        .get('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .query({ conversationId });

      expect(historyRes.status).toBe(200);
      expect(historyRes.body.messages.some((m: any) => m.id === latestMessageId)).toBe(true);

      const pagedRes = await request(app)
        .get('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .query({ conversationId, before: latestMessageId, limit: 1 });

      expect(pagedRes.status).toBe(200);
      expect(pagedRes.body.messages.length).toBeLessThanOrEqual(1);

      const editContent = `edited-${uniqueSuffix()}`;
      const editRes = await request(app)
        .patch(`/api/v1/messages/${latestMessageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ content: editContent });

      expect(editRes.status).toBe(200);
      expect(editRes.body.message.content).toBe(editContent);

      const searchRes = await request(app)
        .get('/api/v1/search')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .query({ q: term, conversationId });

      expect(searchRes.status).toBe(200);
      expect((searchRes.body.hits || []).length).toBeGreaterThan(0);

      const now = new Date().toISOString();
      const timeFilterRes = await request(app)
        .get('/api/v1/search')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .query({ q: term, conversationId, before: now });

      expect(timeFilterRes.status).toBe(200);
      expect(Array.isArray(timeFilterRes.body.hits)).toBe(true);

      const readEventPromise = waitForWsEvent(
        senderSocket,
        (event) => event.event === 'read:updated' && event.data?.lastReadMessageId === latestMessageId,
      );

      const markReadRes = await request(app)
        .put(`/api/v1/messages/${latestMessageId}/read`)
        .set('Authorization', `Bearer ${recipient.accessToken}`)
        .send({});

      expect(markReadRes.status).toBe(200);

      const readEvent = await readEventPromise;
      expect(readEvent.data.userId).toBe(recipient.user.id);

      const listConversationsRes = await request(app)
        .get('/api/v1/conversations')
        .set('Authorization', `Bearer ${recipient.accessToken}`);

      expect(listConversationsRes.status).toBe(200);
      const listedConversation = listConversationsRes.body.conversations.find((c: any) => c.id === conversationId);
      expect(listedConversation).toBeDefined();

      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${latestMessageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`);

      expect(deleteRes.status).toBe(200);
    } finally {
      // Closed by afterEach cleanup.
    }
  });

  it('loads channel history when the client sends only conversationId=<channelUuid>', async () => {
    const user = await createAuthenticatedUser('graderchanconv');
    const slug = `grcc-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ slug, name: slug, description: 'grader channel conv param' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ communityId, name: `grcc-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
    expect(channelRes.status).toBe(201);
    const channelId = channelRes.body.channel.id;

    const sendRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ channelId, content: `chan-grader-${uniqueSuffix()}` });
    expect(sendRes.status).toBe(201);
    const messageId = sendRes.body.message.id;

    const historyRes = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .query({ conversationId: channelId, limit: 30 });

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.messages.some((m: any) => m.id === messageId)).toBe(true);
  });
});
