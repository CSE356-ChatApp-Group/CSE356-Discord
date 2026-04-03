/**
 * WebSocket realtime delivery integration tests.
 *
 * Covers: DM message fanout, channel auto-subscribe, subscribe-on-open race,
 * multi-socket fanout, unsubscribe isolation, rapid resubscribe, reconnect,
 * and repeated-delivery soak checks.
 */

import http from 'http';
import { request, app, wsServer, pool, closeRedisConnections } from './runtime';

import {
  uniqueSuffix,
  createAuthenticatedUser,
  connectWebSocket,
  connectWebSocketWithOpenFrame,
  closeWebSocket,
  waitForWsEvent,
  waitForNoWsEvent,
  waitForRejectedWebSocketConnection,
} from './helpers';

let server: any;
let port: number;

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

// ── DM realtime (message create / update / delete / read receipt) ─────────────

describe('DM realtime delivery', () => {
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

      // message:created
      const createdEventPromise = waitForWsEvent(
        recipientSocket,
        (event) =>
          event.event === 'message:created' && event.data?.conversation_id === conversationId,
      );

      const createMessageRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: 'hello realtime' });

      expect(createMessageRes.status).toBe(201);
      const messageId = createMessageRes.body.message.id;
      const createdEvent = await createdEventPromise;
      expect(createdEvent.data.id).toBe(messageId);

      // message:updated
      const updatedEventPromise = waitForWsEvent(
        recipientSocket,
        (event) => event.event === 'message:updated' && event.data?.id === messageId,
      );

      const updateRes = await request(app)
        .patch(`/api/v1/messages/${messageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ content: 'hello edited realtime' });

      expect(updateRes.status).toBe(200);
      const updatedEvent = await updatedEventPromise;
      expect(updatedEvent.data.content).toBe('hello edited realtime');

      // message:deleted
      const deletedEventPromise = waitForWsEvent(
        recipientSocket,
        (event) => event.event === 'message:deleted' && event.data?.id === messageId,
      );

      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${messageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`);

      expect(deleteRes.status).toBe(200);
      await deletedEventPromise;

      // read:updated
      const secondMessageRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: 'mark read target' });

      expect(secondMessageRes.status).toBe(201);
      const secondMessageId = secondMessageRes.body.message.id;

      const readEventPromise = waitForWsEvent(
        senderSocket,
        (event) =>
          event.event === 'read:updated' && event.data?.lastReadMessageId === secondMessageId,
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

  it('fans out message:deleted to all active sockets for the same recipient', async () => {
    const sender = await createAuthenticatedUser('dmdeletesender');
    const recipient = await createAuthenticatedUser('dmdeleterecipient');

    const recipientSocketA = await connectWebSocket(port, recipient.accessToken);
    const recipientSocketB = await connectWebSocket(port, recipient.accessToken);

    try {
      const createConversationRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ participantIds: [recipient.user.id] });

      expect(createConversationRes.status).toBe(201);
      const conversationId = createConversationRes.body.conversation.id;

      const createMessageRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${sender.accessToken}`)
        .send({ conversationId, content: 'delete fanout target' });

      expect(createMessageRes.status).toBe(201);
      const messageId = createMessageRes.body.message.id;

      const deletedEventA = waitForWsEvent(
        recipientSocketA,
        (event) => event.event === 'message:deleted' && event.data?.id === messageId,
      );
      const deletedEventB = waitForWsEvent(
        recipientSocketB,
        (event) => event.event === 'message:deleted' && event.data?.id === messageId,
      );

      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${messageId}`)
        .set('Authorization', `Bearer ${sender.accessToken}`);

      expect(deleteRes.status).toBe(200);
      await Promise.all([deletedEventA, deletedEventB]);
    } finally {
      await closeWebSocket(recipientSocketA);
      await closeWebSocket(recipientSocketB);
    }
  });
});

// ── Channel auto-subscribe (bootstrap) ───────────────────────────────────────

describe('Channel bootstrap subscriptions', () => {
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
      const createdEventPromise = waitForWsEvent(
        memberSocket,
        (event) => event.event === 'message:created' && event.data?.channel_id === channelId,
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

  it('rejects manual websocket subscribe to private channel when user is not invited', async () => {
    const owner = await createAuthenticatedUser('wsprivowner');
    const communityMember = await createAuthenticatedUser('wsprivmember');

    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        slug: `ws-private-${uniqueSuffix()}`,
        name: 'ws-private',
        description: 'ws private access test',
      });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${communityMember.accessToken}`)
      .send({});
    expect(joinRes.status).toBe(200);

    const privateChannelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId,
        name: `ws-priv-${uniqueSuffix()}`,
        isPrivate: true,
        description: 'private channel',
      });
    expect(privateChannelRes.status).toBe(201);
    const privateChannelId = privateChannelRes.body.channel.id;

    const memberSocket = await connectWebSocket(port, communityMember.accessToken);
    try {
      memberSocket.send(JSON.stringify({ type: 'subscribe', channel: `channel:${privateChannelId}` }));

      const denied = await waitForWsEvent(
        memberSocket,
        (event) => event.event === 'error' && /Channel not allowed/i.test(String(event.data || '')),
      );
      expect(denied.event).toBe('error');

      const noMessagePromise = waitForNoWsEvent(
        memberSocket,
        (event) => event.event === 'message:created' && event.data?.channel_id === privateChannelId,
      );

      const sendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId: privateChannelId, content: `private-${uniqueSuffix()}` });
      expect(sendRes.status).toBe(201);

      await noMessagePromise;
    } finally {
      await closeWebSocket(memberSocket);
    }
  });

  it('delivers access update to invited private-channel members and then allows subscription', async () => {
    const owner = await createAuthenticatedUser('wsprivinviteowner');
    const communityMember = await createAuthenticatedUser('wsprivinvitemember');

    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        slug: `ws-pi-${uniqueSuffix()}`,
        name: 'ws-private-invite',
        description: 'ws private invite test',
      });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${communityMember.accessToken}`)
      .send({});
    expect(joinRes.status).toBe(200);

    const privateChannelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId,
        name: `ws-priv-invite-${uniqueSuffix()}`,
        isPrivate: true,
        description: 'private channel invite',
      });
    expect(privateChannelRes.status).toBe(201);
    const privateChannelId = privateChannelRes.body.channel.id;

    const memberSocket = await connectWebSocket(port, communityMember.accessToken);
    try {
      const membershipUpdatedPromise = waitForWsEvent(
        memberSocket,
        (event) => event.event === 'channel:membership_updated' && event.data?.channelId === privateChannelId,
      );

      const inviteRes = await request(app)
        .post(`/api/v1/channels/${privateChannelId}/members`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ userIds: [communityMember.user.id] });
      expect(inviteRes.status).toBe(200);

      await membershipUpdatedPromise;

      memberSocket.send(JSON.stringify({ type: 'subscribe', channel: `channel:${privateChannelId}` }));
      await waitForWsEvent(
        memberSocket,
        (event) => event.event === 'subscribed' && event.data?.channel === `channel:${privateChannelId}`,
      );

      const createdEventPromise = waitForWsEvent(
        memberSocket,
        (event) => event.event === 'message:created' && event.data?.channel_id === privateChannelId,
      );

      const sendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId: privateChannelId, content: `invited-${uniqueSuffix()}` });
      expect(sendRes.status).toBe(201);

      await createdEventPromise;
    } finally {
      await closeWebSocket(memberSocket);
    }
  });
});

// ── Subscribe-on-open race ────────────────────────────────────────────────────

describe('Subscribe-on-open race condition', () => {
  it('accepts a subscribe frame sent immediately on websocket open', async () => {
    const owner = await createAuthenticatedUser('wsopenowner');
    const leaver = await createAuthenticatedUser('wsopenleaver');
    const third = await createAuthenticatedUser('wsopenthird');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [leaver.user.id, third.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const ownerSocket = await connectWebSocketWithOpenFrame(port, owner.accessToken, {
      type: 'subscribe',
      channel: `conversation:${conversationId}`,
    });

    try {
      await waitForWsEvent(
        ownerSocket,
        (event) =>
          event.event === 'subscribed' && event.data?.channel === `conversation:${conversationId}`,
      );

      const leaveSystemMessagePromise = waitForWsEvent(
        ownerSocket,
        (event) =>
          event.event === 'message:created' &&
          event.data?.conversation_id === conversationId &&
          event.data?.type === 'system' &&
          /left the group\./i.test(event.data?.content || ''),
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
    }
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

    const ownerSocket = await connectWebSocket(port, owner.accessToken);

    try {
      ownerSocket.send(JSON.stringify({ type: 'subscribe', channel: `conversation:${conversationId}` }));
      await waitForWsEvent(
        ownerSocket,
        (event) =>
          event.event === 'subscribed' && event.data?.channel === `conversation:${conversationId}`,
      );

      const leaveSystemMessagePromise = waitForWsEvent(
        ownerSocket,
        (event) =>
          event.event === 'message:created' &&
          event.data?.conversation_id === conversationId &&
          event.data?.type === 'system' &&
          /left the group\./i.test(event.data?.content || ''),
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
    }
  });
});

// ── Multi-socket fanout ───────────────────────────────────────────────────────

describe('Multi-socket fanout', () => {
  it('delivers user-channel realtime events to multiple sockets for the same user', async () => {
    const owner = await createAuthenticatedUser('wsmultiowner');
    const existing = await createAuthenticatedUser('wsmultiexisting');
    const base = await createAuthenticatedUser('wsmultibase');
    const invitee = await createAuthenticatedUser('wsmultiinvitee');

    const socketA = await connectWebSocket(port, invitee.accessToken);
    const socketB = await connectWebSocket(port, invitee.accessToken);

    try {
      const createRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [existing.user.id, base.user.id] });

      expect(createRes.status).toBe(201);
      const groupConversationId = createRes.body.conversation.id;

      const inviteEventPromiseA = waitForWsEvent(
        socketA,
        (event) => event.event === 'conversation:invited',
      );
      const inviteEventPromiseB = waitForWsEvent(
        socketB,
        (event) => event.event === 'conversation:invited',
      );

      const inviteRes = await request(app)
        .post(`/api/v1/conversations/${groupConversationId}/invite`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [invitee.user.id] });

      expect(inviteRes.status).toBe(200);
      const conversationId = inviteRes.body.conversation.id;

      const [eventA, eventB] = await Promise.all([inviteEventPromiseA, inviteEventPromiseB]);
      expect(eventA.data.conversationId).toBe(conversationId);
      expect(eventB.data.conversationId).toBe(conversationId);
      expect(eventA.data.invitedBy).toBe(owner.user.id);
      expect(eventB.data.invitedBy).toBe(owner.user.id);
    } finally {
      await closeWebSocket(socketA);
      await closeWebSocket(socketB);
    }
  });

  it('delivers user-channel events after the user reconnects', async () => {
    const owner = await createAuthenticatedUser('wsreconnectowner');
    const existing = await createAuthenticatedUser('wsreconnectexisting');
    const base = await createAuthenticatedUser('wsreconnectbase');
    const invitee = await createAuthenticatedUser('wsreconnectinvitee');

    const firstSocket = await connectWebSocket(port, invitee.accessToken);
    await closeWebSocket(firstSocket);

    const secondSocket = await connectWebSocket(port, invitee.accessToken);

    try {
      const createRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [existing.user.id, base.user.id] });

      expect(createRes.status).toBe(201);
      const groupConversationId = createRes.body.conversation.id;

      const inviteEventPromise = waitForWsEvent(
        secondSocket,
        (event) => event.event === 'conversation:invited',
      );

      const inviteRes = await request(app)
        .post(`/api/v1/conversations/${groupConversationId}/invite`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [invitee.user.id] });

      expect(inviteRes.status).toBe(200);
      const conversationId = inviteRes.body.conversation.id;

      const inviteEvent = await inviteEventPromise;
      expect(inviteEvent.data.conversationId).toBe(conversationId);
      expect(inviteEvent.data.invitedBy).toBe(owner.user.id);
    } finally {
      await closeWebSocket(secondSocket);
    }
  });
});

// ── Unsubscribe isolation ─────────────────────────────────────────────────────

describe('Unsubscribe isolation', () => {
  it('stops delivery to an unsubscribed channel socket without affecting other sockets', async () => {
    const owner = await createAuthenticatedUser('wsunsubowner');
    const member = await createAuthenticatedUser('wsunsubmember');

    const slug = `ws-unsub-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'unsubscribe isolation test' });

    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({});

    expect(joinRes.status).toBe(200);

    const channelName = `ws-unsub-${uniqueSuffix()}`;
    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId,
        name: channelName,
        isPrivate: false,
        description: 'unsubscribe isolation channel',
      });

    expect(channelRes.status).toBe(201);
    const channelId = channelRes.body.channel.id;

    const socketA = await connectWebSocket(port, member.accessToken);
    const socketB = await connectWebSocket(port, member.accessToken);

    try {
      // Confirm bootstrap delivery to both sockets first.
      const bootstrapEventPromiseA = waitForWsEvent(
        socketA,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'bootstrap delivery check',
      );
      const bootstrapEventPromiseB = waitForWsEvent(
        socketB,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'bootstrap delivery check',
      );

      const bootstrapSendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: 'bootstrap delivery check' });

      expect(bootstrapSendRes.status).toBe(201);
      await Promise.all([bootstrapEventPromiseA, bootstrapEventPromiseB]);

      // Unsubscribe socketA then confirm only socketB receives subsequent messages.
      socketA.send(JSON.stringify({ type: 'unsubscribe', channel: `channel:${channelId}` }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const recipientEventPromise = waitForWsEvent(
        socketB,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'unsubscribe isolation check',
      );
      const noEventPromise = waitForNoWsEvent(
        socketA,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'unsubscribe isolation check',
      );

      const sendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: 'unsubscribe isolation check' });

      expect(sendRes.status).toBe(201);

      const recipientEvent = await recipientEventPromise;
      expect(recipientEvent.data.content).toBe('unsubscribe isolation check');
      await noEventPromise;
    } finally {
      await closeWebSocket(socketA);
      await closeWebSocket(socketB);
    }
  });

  it('delivers exactly one message after rapid unsubscribe and resubscribe on the same channel', async () => {
    const owner = await createAuthenticatedUser('wsburstowner');
    const member = await createAuthenticatedUser('wsburstmember');

    const slug = `ws-burst-${uniqueSuffix()}`;
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'rapid resubscribe test' });

    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({});

    expect(joinRes.status).toBe(200);

    const channelName = `ws-burst-${uniqueSuffix()}`;
    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId,
        name: channelName,
        isPrivate: false,
        description: 'rapid resubscribe channel',
      });

    expect(channelRes.status).toBe(201);
    const channelId = channelRes.body.channel.id;

    const memberSocket = await connectWebSocket(port, member.accessToken);

    try {
      // Bootstrap: confirm initial delivery.
      const bootstrapEventPromise = waitForWsEvent(
        memberSocket,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'rapid resubscribe bootstrap',
      );

      const bootstrapSendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: 'rapid resubscribe bootstrap' });

      expect(bootstrapSendRes.status).toBe(201);
      await bootstrapEventPromise;

      // Rapid unsubscribe + resubscribe in the same tick.
      memberSocket.send(JSON.stringify({ type: 'unsubscribe', channel: `channel:${channelId}` }));
      memberSocket.send(JSON.stringify({ type: 'subscribe', channel: `channel:${channelId}` }));

      await waitForWsEvent(
        memberSocket,
        (event) =>
          event.event === 'subscribed' && event.data?.channel === `channel:${channelId}`,
      );

      const createdEventPromise = waitForWsEvent(
        memberSocket,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'rapid resubscribe target',
      );

      const sendRes = await request(app)
        .post('/api/v1/messages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ channelId, content: 'rapid resubscribe target' });

      expect(sendRes.status).toBe(201);

      const createdEvent = await createdEventPromise;
      expect(createdEvent.data.content).toBe('rapid resubscribe target');

      // No duplicate delivery after the first event arrives.
      await waitForNoWsEvent(
        memberSocket,
        (event) =>
          event.event === 'message:created' &&
          event.data?.channel_id === channelId &&
          event.data?.content === 'rapid resubscribe target' &&
          event.data?.id !== createdEvent.data.id,
        1000,
      );
    } finally {
      await closeWebSocket(memberSocket);
    }
  });
});

// ── Soak / reliability checks ─────────────────────────────────────────────────

describe('WebSocket auth revocation', () => {
  it('rejects revoked access tokens during websocket session establishment', async () => {
    const user = await createAuthenticatedUser('wsrevoked');

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({});

    expect(logoutRes.status).toBe(200);

    const outcome = await waitForRejectedWebSocketConnection(port, user.accessToken, 2000);
    const acceptedOutcome = outcome.closeCode === 4001
      || (outcome.sawError && [1005, 1006].includes(outcome.closeCode));

    if (!acceptedOutcome) {
      throw new Error(
        `Expected revoked websocket connection to be rejected, got closeCode=${outcome.closeCode}, sawError=${outcome.sawError}, errorMessage=${outcome.errorMessage || 'none'}`,
      );
    }
  });
});

describe('WebSocket reliability', () => {
  it('reliably delivers DM invite events across repeated user-channel notifications', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const owner = await createAuthenticatedUser(`wsinviteowner${attempt}`);
      const existing = await createAuthenticatedUser(`wsinviteexisting${attempt}`);
      const base = await createAuthenticatedUser(`wsinvitebase${attempt}`);
      const invitee = await createAuthenticatedUser(`wsinviteinvitee${attempt}`);
      const inviteeSocket = await connectWebSocket(port, invitee.accessToken);

      try {
        const createRes = await request(app)
          .post('/api/v1/conversations')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ participantIds: [existing.user.id, base.user.id] });

        expect(createRes.status).toBe(201);
        const groupConversationId = createRes.body.conversation.id;

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

        const inviteEvent = await inviteEventPromise;
        expect(inviteEvent.data.conversationId).toBe(conversationId);
        expect(inviteEvent.data.invitedBy).toBe(owner.user.id);
        expect(inviteEvent.data.participantIds).toContain(invitee.user.id);
      } finally {
        await closeWebSocket(inviteeSocket);
      }
    }
  }, 60_000);

  it('reliably handles subscribe-on-open across repeated conversation leave broadcasts', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const owner = await createAuthenticatedUser(`wsopenloopowner${attempt}`);
      const leaver = await createAuthenticatedUser(`wsopenloopleaver${attempt}`);
      const third = await createAuthenticatedUser(`wsopenloopthird${attempt}`);

      const createRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ participantIds: [leaver.user.id, third.user.id] });

      expect(createRes.status).toBe(201);
      const conversationId = createRes.body.conversation.id;

      const ownerSocket = await connectWebSocketWithOpenFrame(port, owner.accessToken, {
        type: 'subscribe',
        channel: `conversation:${conversationId}`,
      });

      try {
        await waitForWsEvent(
          ownerSocket,
          (event) =>
            event.event === 'subscribed' &&
            event.data?.channel === `conversation:${conversationId}`,
        );

        const leaveSystemMessagePromise = waitForWsEvent(
          ownerSocket,
          (event) =>
            event.event === 'message:created' &&
            event.data?.conversation_id === conversationId &&
            event.data?.type === 'system' &&
            /left the group\./i.test(event.data?.content || ''),
        );

        const leaveRes = await request(app)
          .post(`/api/v1/conversations/${conversationId}/leave`)
          .set('Authorization', `Bearer ${leaver.accessToken}`)
          .send({});

        expect(leaveRes.status).toBe(200);
        await leaveSystemMessagePromise;
      } finally {
        await closeWebSocket(ownerSocket);
      }
    }
  }, 60_000);
});
