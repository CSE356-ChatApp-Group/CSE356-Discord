/**
 * Channel messaging E2E tests.
 *
 * Covers:
 *  - Edit a message in a channel (UI round-trip)
 *  - Delete a message in a channel (UI round-trip)
 *  - Real-time delivery: User A sends → User B sees it live without reload
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  buildUser,
  bootstrapPageWithToken,
  registerOrLogin,
} from './helpers/session';

test.describe('channel messaging — edit and delete', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let context: BrowserContext;
  let page: Page;
  let token: string;
  let communityId: string;
  let channelId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);

    const user = buildUser('chanmsg');
    context = await browser.newContext();
    page = await context.newPage();

    // Register first, then create community+channel, then bootstrap the page.
    // This ensures the community is already in the DB when the app loads and
    // will appear in the sidebar immediately without needing a second reload.
    token = await registerOrLogin(context.request, user);

    const suffix = Date.now().toString(36);

    const commRes = await context.request.post('/api/v1/communities', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `ChanMsg E2E ${suffix}`, slug: `chanmsg${suffix}` },
    });
    expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
    communityId = (await commRes.json()).community.id;

    const chanRes = await context.request.post('/api/v1/channels', {
      headers: { Authorization: `Bearer ${token}` },
      data: { communityId, name: 'chan-e2e', isPrivate: false },
    });
    expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
    channelId = (await chanRes.json()).channel.id;

    await bootstrapPageWithToken(page, token);
  });

  test.afterAll(async () => {
    try {
      await context.request.delete(`/api/v1/communities/${communityId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* best-effort */ }
    await context?.close();
  });

  /** Navigate to the shared test channel. */
  async function openChannel(p: Page) {
    await p.getByTestId(`community-item-${communityId}`).click();
    await expect(p.getByTestId(`channel-item-${channelId}`)).toBeVisible({ timeout: 15_000 });
    await p.getByTestId(`channel-item-${channelId}`).click();
    await expect(p.getByTestId('message-pane')).toBeVisible({ timeout: 10_000 });
  }

  test('edits a channel message in-place @full @staging', async () => {
    await openChannel(page);

    const original = `Chan edit ${Date.now()}`;
    const updated = `${original} — edited`;

    await page.getByTestId('message-compose-input').fill(original);
    await page.getByTestId('message-send').click();

    const msgLocator = page.locator('[data-message-id]').filter({ hasText: original });
    await expect(msgLocator).toBeVisible();
    const msgId = await msgLocator.getAttribute('data-message-id');

    const messageItem = page.getByTestId(`message-item-${msgId}`);
    await messageItem.hover({ force: true });
    await messageItem.getByRole('button', { name: /edit message/i }).click();

    const editInput = messageItem.locator('textarea');
    await editInput.fill(updated);
    await editInput.press('Enter');

    await expect(
      page.locator('[data-message-id]').filter({ hasText: updated }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('deletes a channel message @full @staging', async () => {
    await openChannel(page);

    const content = `Chan delete ${Date.now()}`;
    await page.getByTestId('message-compose-input').fill(content);
    await page.getByTestId('message-send').click();

    const msgLocator = page.locator('[data-message-id]').filter({ hasText: content });
    await expect(msgLocator).toBeVisible();
    const msgId = await msgLocator.getAttribute('data-message-id');

    page.once('dialog', (d) => d.accept());

    const messageItem = page.getByTestId(`message-item-${msgId}`);
    await messageItem.hover({ force: true });
    await messageItem.getByRole('button', { name: /delete message/i }).click();

    await expect.poll(
      async () => page.getByTestId(`message-item-${msgId}`).count(),
      { timeout: 30_000, intervals: [1_000] },
    ).toBe(0);
  });
});

test.describe('channel real-time delivery', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test(
    "message from User A appears on User B's page without reload @full @staging @heavy-auth",
    async ({ browser }) => {
      const userA = buildUser('rtA');
      const userB = buildUser('rtB');

      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();

      try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        const suffix = Date.now().toString(36);

        // Register both users and create the community+channel before loading
        // any pages, so both pages mount with the community already in the DB.
        const tokenA = await registerOrLogin(ctxA.request, userA);
        const tokenB = await registerOrLogin(ctxB.request, userB);

        // A creates a community + public channel.
        const commRes = await ctxA.request.post('/api/v1/communities', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { name: `RT E2E ${suffix}`, slug: `rte2e${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'realtime-chan', isPrivate: false },
        });
        expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        // B joins the community before their page loads.
        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join community: ${joinRes.status()}`).toBeTruthy();

        // Load both pages simultaneously.
        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
        ]);

        // B navigates to the channel (subscribing via WebSocket).
        await pageB.getByTestId(`community-item-${communityId}`).click();
        await expect(pageB.getByTestId(`channel-item-${channelId}`)).toBeVisible({ timeout: 15_000 });
        await pageB.getByTestId(`channel-item-${channelId}`).click();
        await expect(pageB.getByTestId('message-pane')).toBeVisible({ timeout: 10_000 });

        // A sends a message via the API.
        const messageContent = `RT delivery ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId, content: messageContent },
        });
        expect(msgRes.ok(), `send message: ${msgRes.status()}`).toBeTruthy();

        // B should see the message appear without any reload.
        await expect(
          pageB.locator('[data-message-id]').filter({ hasText: messageContent }),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );

  test(
    'sender sees their own API-sent message when the channel is open @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('rtSender');
      const userB = buildUser('rtPeer');

      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();

      try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        const suffix = Date.now().toString(36);

        const tokenA = await registerOrLogin(ctxA.request, userA);
        const tokenB = await registerOrLogin(ctxB.request, userB);

        const commRes = await ctxA.request.post('/api/v1/communities', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { name: `RT sender E2E ${suffix}`, slug: `rtsend${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'realtime-sender-chan', isPrivate: false },
        });
        expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join community: ${joinRes.status()}`).toBeTruthy();

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
        ]);

        async function openChannelFor(p: Page) {
          await p.getByTestId(`community-item-${communityId}`).click();
          await expect(p.getByTestId(`channel-item-${channelId}`)).toBeVisible({
            timeout: 15_000,
          });
          await p.getByTestId(`channel-item-${channelId}`).click();
          await expect(p.getByTestId('message-pane')).toBeVisible({ timeout: 10_000 });
        }

        await Promise.all([openChannelFor(pageA), openChannelFor(pageB)]);

        const messageContent = `RT sender self ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId, content: messageContent },
        });
        expect(msgRes.ok(), `send message: ${msgRes.status()}`).toBeTruthy();

        const msgLocator = pageA.locator('[data-message-id]').filter({
          hasText: messageContent,
        });
        await expect(msgLocator).toBeVisible({ timeout: 15_000 });

        await expect(
          pageB.locator('[data-message-id]').filter({ hasText: messageContent }),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );
});

test.describe('private channel real-time delivery', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test(
    "message from owner appears for invited member without reload @full @staging @heavy-auth",
    async ({ browser }) => {
      const userA = buildUser('privRtA');
      const userB = buildUser('privRtB');

      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();

      try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        const suffix = Date.now().toString(36);

        const tokenA = await registerOrLogin(ctxA.request, userA);
        const tokenB = await registerOrLogin(ctxB.request, userB);

        const meB = await ctxB.request.get('/api/v1/users/me', {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(meB.ok(), `users/me: ${meB.status()}`).toBeTruthy();
        const userBId: string = (await meB.json()).user?.id;
        expect(Boolean(userBId), 'user B id').toBeTruthy();

        const commRes = await ctxA.request.post('/api/v1/communities', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { name: `PrivRT E2E ${suffix}`, slug: `privrt${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'priv-realtime-chan', isPrivate: true },
        });
        expect(chanRes.ok(), `create private channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join community: ${joinRes.status()}`).toBeTruthy();

        const addRes = await ctxA.request.post(`/api/v1/channels/${channelId}/members`, {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { userIds: [userBId] },
        });
        expect(addRes.ok(), `add B to private channel: ${addRes.status()}`).toBeTruthy();

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
        ]);

        await pageA.getByTestId(`community-item-${communityId}`).click();
        await expect(pageA.getByTestId(`channel-item-${channelId}`)).toBeVisible({ timeout: 20_000 });
        await pageA.getByTestId(`channel-item-${channelId}`).click();
        await expect(pageA.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });

        await pageB.getByTestId(`community-item-${communityId}`).click();
        await expect(pageB.getByTestId(`channel-item-${channelId}`)).toBeVisible({ timeout: 20_000 });
        await pageB.getByTestId(`channel-item-${channelId}`).click();
        await expect(pageB.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });

        const messageContent = `priv-RT ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId, content: messageContent },
        });
        expect(msgRes.ok(), `send message: ${msgRes.status()}`).toBeTruthy();

        await expect(
          pageB.locator('[data-message-id]').filter({ hasText: messageContent }),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );
});
