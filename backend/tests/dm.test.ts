/**
 * DM / conversation lifecycle integration tests.
 *
 * Covers: invite flow, leave, guard rails, 1:1 vs group
 * deletion, history retention, and system message persistence.
 */

import http from 'http';
import { request, app, wsServer, pool, closeRedisConnections } from './runtime';

import {
  createAuthenticatedUser,
  connectWebSocket,
  closeWebSocket,
  waitForWsEvent,
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

// ── Invite flow ───────────────────────────────────────────────────────────────

describe('DM invite flow', () => {
  it('adds invited participants immediately and allows them to leave', async () => {
    const userA = await createAuthenticatedUser('dmowner');
    const userB = await createAuthenticatedUser('dminitial');
    const userC = await createAuthenticatedUser('dminvite');
    const userD = await createAuthenticatedUser('dmbasegroup');

    const inviteeSocket = await connectWebSocket(port, userC.accessToken);

    try {
      // Start with a true group DM, then invite userC.
      const createRes = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ participantIds: [userB.user.id, userD.user.id] });

      expect(createRes.status).toBe(201);
      const conversationId = createRes.body.conversation.id;

      const inviteEventPromise = waitForWsEvent(
        inviteeSocket,
        (event) =>
          event.event === 'conversation:invited' && event.data?.conversationId === conversationId,
      );

      const inviteRes = await request(app)
        .post(`/api/v1/conversations/${conversationId}/invite`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ participantIds: [userC.user.id] });

      expect(inviteRes.status).toBe(200);
      expect(inviteRes.body.addedParticipantIds).toContain(userC.user.id);

      const inviteEvent = await inviteEventPromise;
      expect(inviteEvent.data.conversationId).toBe(conversationId);

      // Invited users are immediately active participants.
      const pendingListRes = await request(app)
        .get('/api/v1/conversations')
        .set('Authorization', `Bearer ${userC.accessToken}`);

      expect(pendingListRes.status).toBe(200);
      expect(
        pendingListRes.body.conversations.find((c: any) => c.id === conversationId),
      ).toBeDefined();

      // Group join system message is emitted at invite time.
      const messagesAfterInvite = await request(app)
        .get('/api/v1/messages')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .query({ conversationId });

      expect(messagesAfterInvite.status).toBe(200);
      expect(
        messagesAfterInvite.body.messages.some(
          (m: any) => m.type === 'system' && /joined the group\./i.test(m.content || ''),
        ),
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
      expect(
        listRes.body.conversations.find((c: any) => c.id === conversationId),
      ).toBeUndefined();
    } finally {
      await closeWebSocket(inviteeSocket);
    }
  });
});

describe('DM participant resolution', () => {
  it('creates a group DM even when one selected participant has no email address', async () => {
    const owner = await createAuthenticatedUser('dmnullmailowner');
    const noEmailUser = await createAuthenticatedUser('dmnullmailnoemail', { withEmail: false });
    const thirdUser = await createAuthenticatedUser('dmnullmailthird');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ participantIds: [noEmailUser.user.id, thirdUser.user.id] });

    expect(createRes.status).toBe(201);
    expect(createRes.body.created).toBe(true);
    expect(createRes.body.conversation?.is_group).toBe(true);
    expect(createRes.body.conversation?.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: owner.user.id }),
        expect.objectContaining({ id: noEmailUser.user.id }),
        expect.objectContaining({ id: thirdUser.user.id }),
      ]),
    );
  });
});

// ── Leave / guard rails ───────────────────────────────────────────────────────

describe('DM leave and access guards', () => {
  it('blocks DM edits, deletes, and read receipts after a participant leaves', async () => {
    const owner = await createAuthenticatedUser('dmguardowner');
    const participant = await createAuthenticatedUser('dmguardparticipant');
    const third = await createAuthenticatedUser('dmguardthird');

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

  it('blocks inviting additional users into a 1:1 DM conversation', async () => {
    const userA = await createAuthenticatedUser('dm1to1a');
    const userB = await createAuthenticatedUser('dm1to1b');
    const userC = await createAuthenticatedUser('dm1to1c');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ participantIds: [userB.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const inviteRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/invite`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ participantIds: [userC.user.id] });

    expect(inviteRes.status).toBe(403);
    expect(inviteRes.body.error).toMatch(/cannot invite users to a 1-to-1 dm/i);

    const listResB = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userB.accessToken}`);

    expect(listResB.status).toBe(200);
    expect(listResB.body.conversations.find((c: any) => c.id === conversationId)).toBeDefined();

    const listResA = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect(listResA.status).toBe(200);
    expect(listResA.body.conversations.find((c: any) => c.id === conversationId)).toBeDefined();
  });

  it('deletes a group DM and all history when the last participant leaves', async () => {
    const userA = await createAuthenticatedUser('dmgrouplastleavera');
    const userB = await createAuthenticatedUser('dmgrouplastleaverb');
    const userC = await createAuthenticatedUser('dmgrouplastleaverc');

    const createRes = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ participantIds: [userB.user.id, userC.user.id] });

    expect(createRes.status).toBe(201);
    const conversationId = createRes.body.conversation.id;

    const messageRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ conversationId, content: 'group history that should be cleaned up' });

    expect(messageRes.status).toBe(201);

    const leaveARes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({});
    expect(leaveARes.status).toBe(200);

    const leaveBRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({});
    expect(leaveBRes.status).toBe(200);

    const listResCBeforeFinalLeave = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userC.accessToken}`);

    expect(listResCBeforeFinalLeave.status).toBe(200);
    expect(listResCBeforeFinalLeave.body.conversations.find((c: any) => c.id === conversationId)).toBeDefined();

    const leaveCRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userC.accessToken}`)
      .send({});
    expect(leaveCRes.status).toBe(200);

    const dbConversationRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM conversations WHERE id = $1',
      [conversationId]
    );
    expect(dbConversationRes.rows[0].count).toBe(0);

    const dbMessageRes = await pool.query(
      'SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id = $1',
      [conversationId]
    );
    expect(dbMessageRes.rows[0].count).toBe(0);
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

    await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ conversationId, content: 'farewell message' });

    const leaveRes = await request(app)
      .post(`/api/v1/conversations/${conversationId}/leave`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({});

    expect(leaveRes.status).toBe(200);

    const listResB = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userB.accessToken}`);

    expect(listResB.status).toBe(200);
    expect(listResB.body.conversations.find((c: any) => c.id === conversationId)).toBeDefined();

    const listResC = await request(app)
      .get('/api/v1/conversations')
      .set('Authorization', `Bearer ${userC.accessToken}`);

    expect(listResC.status).toBe(200);
    expect(listResC.body.conversations.find((c: any) => c.id === conversationId)).toBeDefined();
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
      (m: any) => m.type === 'system' && /left the group\./i.test(m.content || ''),
    );

    expect(leaveMessage).toBeDefined();
    expect(leaveMessage.author_id).toBeNull();
    expect(leaveMessage.author).toBeNull();
  });
});
