/**
 * DM real-time delivery (1:1): both users have the thread open; sender posts via
 * REST; receiver must see the row without reload. Mirrors the channel test in
 * channel-messaging.spec.ts (which already covered public channels only).
 */

import { test, expect } from '@playwright/test';
import {
  buildUser,
  bootstrapPageWithToken,
  registerOrLogin,
  waitForSidebar,
} from './helpers/session';

test.describe('DM real-time delivery', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test("1:1 receiver sees sender's API message without reload @full @staging @heavy-auth", async ({
    browser,
  }) => {
    const userA = buildUser('dmrtA');
    const userB = buildUser('dmrtB');

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      const tokenA = await registerOrLogin(ctxA.request, userA);
      const tokenB = await registerOrLogin(ctxB.request, userB);

      const convRes = await ctxA.request.post('/api/v1/conversations', {
        headers: { Authorization: `Bearer ${tokenA}` },
        data: { participantIds: [userB.username] },
      });
      expect(convRes.ok(), `create DM: ${convRes.status()}`).toBeTruthy();
      const conversationId: string = (await convRes.json()).conversation.id;

      await Promise.all([
        bootstrapPageWithToken(pageA, tokenA),
        bootstrapPageWithToken(pageB, tokenB),
      ]);
      await waitForSidebar(pageA);
      await waitForSidebar(pageB);

      await expect(pageA.getByTestId(`dm-item-${conversationId}`)).toBeVisible({ timeout: 20_000 });
      await expect(pageB.getByTestId(`dm-item-${conversationId}`)).toBeVisible({ timeout: 20_000 });

      await pageA.getByTestId(`dm-item-${conversationId}`).click();
      await expect(pageA.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });
      await pageB.getByTestId(`dm-item-${conversationId}`).click();
      await expect(pageB.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });

      const messageContent = `dm-rt ${Date.now()}`;
      const msgRes = await ctxB.request.post('/api/v1/messages', {
        headers: { Authorization: `Bearer ${tokenB}` },
        data: { conversationId, content: messageContent },
      });
      expect(msgRes.ok(), `send DM message: ${msgRes.status()}`).toBeTruthy();

      await expect(
        pageA.locator('[data-message-id]').filter({ hasText: messageContent }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe('group DM real-time delivery', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('other members see group message from API without reload @full @staging @heavy-auth', async ({
    browser,
  }) => {
    const userA = buildUser('gdmrtA');
    const userB = buildUser('gdmrtB');
    const userC = buildUser('gdmrtC');

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const pageC = await ctxC.newPage();

      const tokenA = await registerOrLogin(ctxA.request, userA);
      const tokenB = await registerOrLogin(ctxB.request, userB);
      const tokenC = await registerOrLogin(ctxC.request, userC);

      const convRes = await ctxA.request.post('/api/v1/conversations', {
        headers: { Authorization: `Bearer ${tokenA}` },
        data: { participantIds: [userB.username, userC.username] },
      });
      expect(convRes.ok(), `create group DM: ${convRes.status()}`).toBeTruthy();
      const conversationId: string = (await convRes.json()).conversation.id;

      await Promise.all([
        bootstrapPageWithToken(pageA, tokenA),
        bootstrapPageWithToken(pageB, tokenB),
        bootstrapPageWithToken(pageC, tokenC),
      ]);
      await waitForSidebar(pageA);
      await waitForSidebar(pageB);
      await waitForSidebar(pageC);

      const dmItem = (p: typeof pageA) => p.getByTestId(`dm-item-${conversationId}`);
      await expect(dmItem(pageA)).toBeVisible({ timeout: 25_000 });
      await expect(dmItem(pageB)).toBeVisible({ timeout: 25_000 });
      await expect(dmItem(pageC)).toBeVisible({ timeout: 25_000 });

      await dmItem(pageA).click();
      await dmItem(pageB).click();
      await dmItem(pageC).click();
      await expect(pageA.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });
      await expect(pageB.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });
      await expect(pageC.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });

      const messageContent = `gdm-rt ${Date.now()}`;
      const msgRes = await ctxC.request.post('/api/v1/messages', {
        headers: { Authorization: `Bearer ${tokenC}` },
        data: { conversationId, content: messageContent },
      });
      expect(msgRes.ok(), `send group DM message: ${msgRes.status()}`).toBeTruthy();

      const row = (p: typeof pageA) =>
        p.locator('[data-message-id]').filter({ hasText: messageContent });
      await expect(row(pageA)).toBeVisible({ timeout: 15_000 });
      await expect(row(pageB)).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
      await ctxC.close();
    }
  });
});
