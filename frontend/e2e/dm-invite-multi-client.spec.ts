import { test, expect } from '@playwright/test';
import {
  bootstrapPageWithToken,
  buildUser,
  createGroupAndInvite,
  ensureUserExists,
  ensureAuthenticated,
  findExistingUsername,
  waitForSidebar,
  waitForAuthSlot,
} from './helpers/session';

test.describe('DM invite multi-client sync', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('group DM invite and leave sync across tabs @full @staging @heavy-auth', async ({ browser }) => {
    const userA = buildUser('alice');
    const userB = buildUser('bob');
    const userC = buildUser('carol');

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const aTab1 = await contextA.newPage();

      const aliceToken = await ensureAuthenticated(contextA, aTab1, userA);
      await ensureUserExists(contextB.request, userB);
      await ensureUserExists(contextB.request, userC);

      const aTab2 = await contextA.newPage();
      await waitForAuthSlot();
      await bootstrapPageWithToken(aTab2, aliceToken);

      await waitForSidebar(aTab1);
      await waitForSidebar(aTab2);

      const baselineA1 = await aTab1.locator('[data-testid^="dm-item-"]').count();
      const baselineA2 = await aTab2.locator('[data-testid^="dm-item-"]').count();

      const conversationId = await createGroupAndInvite(
        contextB.request,
        [userB.username, userC.username],
        userA.username,
      );

      await expect.poll(async () => aTab1.getByTestId(`dm-item-${conversationId}`).count(), { timeout: 15_000 }).toBe(1);
      await expect.poll(async () => aTab2.getByTestId(`dm-item-${conversationId}`).count(), { timeout: 15_000 }).toBe(1);
      await expect.poll(async () => aTab1.locator('[data-testid^="dm-item-"]').count(), { timeout: 15_000 }).toBeGreaterThan(baselineA1);
      await expect.poll(async () => aTab2.locator('[data-testid^="dm-item-"]').count(), { timeout: 15_000 }).toBeGreaterThan(baselineA2);

      await aTab1.getByTestId(`dm-item-${conversationId}`).click();
      await expect(aTab1.getByTestId('message-pane')).toBeVisible();
      await expect(aTab1.getByTestId('dm-invite-button')).toBeVisible();
      await expect(aTab1.getByTestId('dm-leave-button')).toBeVisible();

      await aTab1.getByTestId('dm-leave-button').click();
      await expect(aTab1.getByTestId('dm-leave-modal')).toBeVisible();
      await aTab1.getByTestId('dm-leave-confirm').click();

      await expect.poll(async () => aTab1.getByTestId(`dm-item-${conversationId}`).count(), { timeout: 15_000 }).toBe(0);
      await expect.poll(async () => aTab2.getByTestId(`dm-item-${conversationId}`).count(), { timeout: 15_000 }).toBe(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
