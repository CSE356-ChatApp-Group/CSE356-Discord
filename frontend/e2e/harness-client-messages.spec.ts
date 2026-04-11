/**
 * Emulates course/generated clients that call GET /messages with only
 * `conversationId=` even for channel threads (no `channelId` query param).
 *
 * Runs against the same stack as other @full tests (local docker / staging).
 */

import { test, expect } from '@playwright/test';

import { buildUser, registerOrLogin } from './helpers/session';

test.describe('harness-style GET /messages', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('conversationId-only matches channelId for latest page and before= pagination @full @staging', async ({
    request,
  }) => {
    const user = buildUser('harnessmsg');
    const token = await registerOrLogin(request, user);
    const suffix = Date.now().toString(36);
    const auth = { Authorization: `Bearer ${token}` };

    const commRes = await request.post('/api/v1/communities', {
      headers: auth,
      data: { name: `Harness msg ${suffix}`, slug: `harnessmsg${suffix}` },
    });
    expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
    const communityId = (await commRes.json()).community.id;

    const chanRes = await request.post('/api/v1/channels', {
      headers: auth,
      data: { communityId, name: 'harness-general', isPrivate: false },
    });
    expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
    const channelId = (await chanRes.json()).channel.id;

    const msgIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request.post('/api/v1/messages', {
        headers: auth,
        data: { channelId, content: `harness-line-${i}-${suffix}` },
      });
      expect(res.ok(), `post message ${i}: ${res.status()}`).toBeTruthy();
      msgIds.push((await res.json()).message.id);
    }
    const [, , id3] = msgIds;

    const viaConv = await request.get(`/api/v1/messages?conversationId=${channelId}&limit=30`, {
      headers: auth,
    });
    const viaChan = await request.get(`/api/v1/messages?channelId=${channelId}&limit=30`, {
      headers: auth,
    });
    expect(viaConv.ok()).toBeTruthy();
    expect(viaChan.ok()).toBeTruthy();
    const convIds = ((await viaConv.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    const chanIds = ((await viaChan.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    expect(convIds).toEqual(chanIds);

    const pageConv = await request.get(
      `/api/v1/messages?conversationId=${encodeURIComponent(channelId)}&before=${encodeURIComponent(id3)}&limit=10`,
      { headers: auth },
    );
    const pageChan = await request.get(
      `/api/v1/messages?channelId=${encodeURIComponent(channelId)}&before=${encodeURIComponent(id3)}&limit=10`,
      { headers: auth },
    );
    expect(pageConv.ok()).toBeTruthy();
    expect(pageChan.ok()).toBeTruthy();
    const pConv = ((await pageConv.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    const pChan = ((await pageChan.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    expect(pConv).toEqual(pChan);
    expect(pConv.length).toBeGreaterThan(0);
  });

  test('DM history still resolves by real conversation id @full @staging', async ({ request }) => {
    const alice = buildUser('harnessDmA');
    const bob = buildUser('harnessDmB');
    const tokenA = await registerOrLogin(request, alice);
    const tokenB = await registerOrLogin(request, bob);

    const meB = await request.get('/api/v1/users/me', {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(meB.ok()).toBeTruthy();
    const bobUserId = (await meB.json()).user.id as string;

    const dmRes = await request.post('/api/v1/conversations', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { participantIds: [bobUserId] },
    });
    expect(dmRes.ok(), `open DM: ${dmRes.status()}`).toBeTruthy();
    const conversationId = (await dmRes.json()).conversation.id as string;

    const postRes = await request.post('/api/v1/messages', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { conversationId, content: `dm-harness-${Date.now()}` },
    });
    expect(postRes.ok()).toBeTruthy();
    const messageId = (await postRes.json()).message.id as string;

    const hist = await request.get(`/api/v1/messages?conversationId=${conversationId}&limit=20`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(hist.ok()).toBeTruthy();
    const messages = ((await hist.json()) as { messages: { id: string }[] }).messages;
    expect(messages.some((m) => m.id === messageId)).toBeTruthy();
  });
});
