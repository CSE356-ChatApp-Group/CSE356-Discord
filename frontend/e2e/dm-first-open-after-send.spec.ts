/**
 * Regression: recipient opens a 1:1 DM only after the sender has already posted.
 * Stale Redis latest-page cache plus replacing the in-memory list on first fetch
 * used to hide the sender's messages until refresh.
 */

import { test, expect } from '@playwright/test';
import {
  bootstrapPageWithToken,
  buildUser,
  ensureUserExists,
  ensureAuthenticated,
  waitForSidebar,
} from './helpers/session';

test.describe('DM first open after sender posts', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('recipient sees messages when opening thread after sender sent @full @staging @heavy-auth', async ({
    browser,
  }) => {
    const userA = buildUser('dmopenA');
    const userB = buildUser('dmopenB');

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      const tokenA = await ensureAuthenticated(ctxA, pageA, userA);
      const tokenB = await ensureUserExists(ctxB.request, userB);

      const convRes = await ctxB.request.post('/api/v1/conversations', {
        headers: { Authorization: `Bearer ${tokenB}` },
        data: { participantIds: [userA.username] },
        timeout: 10_000,
      });
      expect(convRes.ok(), `create 1:1 DM: ${convRes.status()}`).toBeTruthy();
      const conversationId: string = (await convRes.json()).conversation.id;
      expect(Boolean(conversationId)).toBeTruthy();

      await waitForSidebar(pageA);
      await expect
        .poll(async () => pageA.getByTestId(`dm-item-${conversationId}`).count(), { timeout: 15_000 })
        .toBe(1);

      await bootstrapPageWithToken(pageB, tokenB);
      await waitForSidebar(pageB);
      await pageB.getByTestId(`dm-item-${conversationId}`).click();
      await expect(pageB.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });

      const messageContent = `dm-first-open ${Date.now()}`;
      await pageB.getByTestId('message-compose-input').fill(messageContent);
      await pageB.getByTestId('message-send').click();

      await expect(
        pageB.locator('[data-message-id]').filter({ hasText: messageContent }),
      ).toBeVisible({ timeout: 15_000 });

      await pageA.getByTestId(`dm-item-${conversationId}`).click();
      await expect(pageA.getByTestId('message-pane')).toBeVisible({ timeout: 15_000 });

      await expect(
        pageA.locator('[data-message-id]').filter({ hasText: messageContent }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
