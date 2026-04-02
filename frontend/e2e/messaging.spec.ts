import { test, expect, type BrowserContext, type Page, type Browser } from '@playwright/test';
import {
  buildUser,
  bootstrapPageWithToken,
  ensureUserExists,
  loginViaUiWithRetry,
  registerOrLogin,
} from './helpers/session';

/**
 * Sets up an authenticated Alice context with a DM conversation already
 * created against Bob, then bootstraps Alice's page.
 *
 * By creating the conversation *before* the initial page load, it appears in
 * Alice's sidebar immediately when fetchConversations() runs on mount — no
 * reload or polling wait required.
 */
async function setupDmSession(browser: Browser) {
  const aliceCtx = await browser.newContext();
  const alicePage = await aliceCtx.newPage();
  const alice = buildUser('alice');
  const bob = buildUser('bob');

  // Register Alice and Bob sequentially to avoid hammering auth.
  const aliceToken = await registerOrLogin(aliceCtx.request, alice);

  const bobCtx = await browser.newContext();
  await ensureUserExists(bobCtx.request, bob);
  await bobCtx.close();

  try {
    await bootstrapPageWithToken(alicePage, aliceToken);
  } catch {
    await loginViaUiWithRetry(alicePage, alice);
  }

  // Create a DM through the UI to ensure the sidebar state updates immediately
  // in the current browser session.
  await alicePage.getByTestId('dm-create-open').click();
  await expect(alicePage.getByTestId('dm-create-modal')).toBeVisible();
  await alicePage.getByTestId('dm-search-input').fill(bob.username);

  const bobResult = alicePage
    .locator('[data-testid^="dm-user-result-"]')
    .filter({ hasText: bob.username })
    .first();
  await expect(bobResult).toBeVisible({ timeout: 15_000 });
  await bobResult.click();
  await alicePage.getByTestId('dm-create-submit').click();

  const dmItem = alicePage.locator('[data-testid^="dm-item-"]').first();
  await expect(dmItem).toBeVisible({ timeout: 15_000 });
  const conversationId = await dmItem.getAttribute('data-conversation-id');
  expect(conversationId, 'conversation id should be present on DM item').toBeTruthy();
  const convId = conversationId!;

  return { context: aliceCtx, page: alicePage, convId };
}

async function setupDmSessionWithRetry(browser: Browser) {
  const attempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await setupDmSession(browser);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
  }

  throw lastError;
}

test.describe('messaging in a DM conversation', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  // Share a single authenticated session across all three messaging tests to
  // minimise auth calls and keep total test time low.
  let context: BrowserContext;
  let page: Page;
  let convId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);
    ({ context, page, convId } = await setupDmSessionWithRetry(browser));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.beforeEach(async () => {
    // Each test starts from a known state: the shared DM is open.
    await expect(page.getByTestId(`dm-item-${convId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`dm-item-${convId}`).click();
    await expect(page.getByTestId('message-pane')).toBeVisible();
  });

  test('sends a message via the compose box @full @heavy-auth @staging', async () => {
    const content = `Hello from E2E ${Date.now()}`;

    await page.getByTestId('message-compose-input').fill(content);
    await page.getByTestId('message-send').click();

    await expect(
      page.locator('[data-message-id]').filter({ hasText: content }),
    ).toBeVisible();
  });

  test('edits a sent message in-place @full @heavy-auth @staging', async () => {
    const original = `Edit me ${Date.now()}`;
    const updated = `${original} — updated`;

    // Send the original message.
    await page.getByTestId('message-compose-input').fill(original);
    await page.getByTestId('message-send').click();

    const messageLocator = page.locator('[data-message-id]').filter({ hasText: original });
    await expect(messageLocator).toBeVisible();
    const msgId = await messageLocator.getAttribute('data-message-id');

    // Hover to reveal the action toolbar, then click Edit.
    const messageItem = page.getByTestId(`message-item-${msgId}`);
    await messageItem.hover();
    await messageItem.getByRole('button', { name: /edit message/i }).click();

    // Clear and fill the inline textarea, then submit with Enter.
    const editInput = messageItem.locator('textarea');
    await editInput.fill(updated);
    await editInput.press('Enter');

    // The updated text must be visible in the message list.
    await expect(
      page.locator('[data-message-id]').filter({ hasText: updated }),
    ).toBeVisible();
  });

  test('deletes a sent message @full @heavy-auth @experimental', async () => {
    const content = `Delete me ${Date.now()}`;

    await page.getByTestId('message-compose-input').fill(content);
    await page.getByTestId('message-send').click();

    const messageLocator = page.locator('[data-message-id]').filter({ hasText: content });
    await expect(messageLocator).toBeVisible();
    const msgId = await messageLocator.getAttribute('data-message-id');

    // Accept the confirm() dialog that the delete button triggers.
    page.once('dialog', (dialog) => dialog.accept());

    const messageItem = page.getByTestId(`message-item-${msgId}`);
    await messageItem.hover();
    await messageItem.getByRole('button', { name: /delete message/i }).click();

    // Hard delete contract: deleted message must disappear from UI entirely.
    await expect.poll(
      async () => page.getByTestId(`message-item-${msgId}`).count(),
      { timeout: 30_000, intervals: [1_000] },
    ).toBe(0);
  });
});
