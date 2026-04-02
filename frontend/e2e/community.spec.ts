import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { buildUser, ensureAuthenticated } from './helpers/session';

/** Generates a random lowercase alphanumeric suffix (6 chars). */
function randSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

test.describe('community and channel', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);
    context = await browser.newContext();
    page = await context.newPage();
    await ensureAuthenticated(context, page, buildUser('community'));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('creates a community and a channel via the UI @smoke @full @staging', async () => {
    const suffix = randSuffix();
    const communityName = `E2E Comm ${suffix}`;
    // Slugs must be lowercase alphanumeric (+ hyphens are acceptable).
    const communitySlug = `e2e${suffix}`;

    // ── 1. Create community ──────────────────────────────────────────────────
    await page.getByTestId('community-create-open').click();
    await expect(page.getByTestId('community-create-form')).toBeVisible();

    await page.getByTestId('community-create-name').fill(communityName);
    await page.getByTestId('community-create-slug').fill(communitySlug);
    await page.getByTestId('community-create-submit').click();

    // After creation the community becomes active and the channel sidebar
    // switches to community mode, revealing the "new channel" button.
    await expect(
      page.getByTestId('channel-create-open'),
    ).toBeVisible({ timeout: 10_000 });

    // ── 2. Create channel ────────────────────────────────────────────────────
    const channelName = `chan${randSuffix().slice(0, 4)}`;

    await page.getByTestId('channel-create-open').click();
    await expect(page.getByTestId('channel-create-form')).toBeVisible();

    await page.getByTestId('channel-create-name').fill(channelName);
    await page.getByTestId('channel-create-submit').click();
    // Wait for the modal to close before checking the sidebar list.
    await expect(page.getByTestId('channel-create-form')).not.toBeVisible({ timeout: 10_000 });

    // The new channel appears in the sidebar list.
    const channelItem = page
      .locator('[data-testid^="channel-item-"]')
      .filter({ hasText: channelName });
    await expect(channelItem).toBeVisible({ timeout: 20_000 });
  });

  test('sends a message in a channel @smoke @full @staging', async () => {
    const suffix = randSuffix();

    // Create a community + channel via UI so the test is fully end-to-end.
    await page.getByTestId('community-create-open').click();
    await expect(page.getByTestId('community-create-form')).toBeVisible();
    await page.getByTestId('community-create-name').fill(`E2E Msg ${suffix}`);
    await page.getByTestId('community-create-slug').fill(`e2emsg${suffix}`);
    await page.getByTestId('community-create-submit').click();
    await expect(page.getByTestId('channel-create-open')).toBeVisible({ timeout: 10_000 });

    const channelName = `msg${randSuffix().slice(0, 4)}`;
    await page.getByTestId('channel-create-open').click();
    await expect(page.getByTestId('channel-create-form')).toBeVisible();
    await page.getByTestId('channel-create-name').fill(channelName);
    await page.getByTestId('channel-create-submit').click();
    await expect(page.getByTestId('channel-create-form')).not.toBeVisible({ timeout: 10_000 });

    // Open the channel.
    await page
      .locator('[data-testid^="channel-item-"]')
      .filter({ hasText: channelName })
      .click();
    await expect(page.getByTestId('message-pane')).toBeVisible();

    // Send a message and verify it appears in the list.
    const content = `Hello from channel E2E! ${Date.now()}`;
    await page.getByTestId('message-compose-input').fill(content);
    await page.getByTestId('message-send').click();

    await expect(
      page.locator('[data-message-id]').filter({ hasText: content }),
    ).toBeVisible();
  });
});
