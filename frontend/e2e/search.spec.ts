import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  buildUser,
  ensureAuthenticated,
  bootstrapPageWithToken,
} from './helpers/session';

/** Unique token embedded in messages so the search can't accidentally match
 *  messages from other test runs sharing the same staging namespace. */
function uniqueToken() {
  return `srch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('message search', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let context: BrowserContext;
  let page: Page;
  let token: string;
  let communityId: string;
  let channelId: string;
  let messageToken: string;
  let messageIds: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const user = buildUser('search');
    context = await browser.newContext();
    page = await context.newPage();
    token = await ensureAuthenticated(context, page, user);

    // ── Create a community + channel via API ──────────────────────────────
    const suffix = Date.now().toString(36);
    const commRes = await context.request.post('/api/v1/communities', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `Search E2E ${suffix}`, slug: `srche2e${suffix}` },
    });
    expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
    communityId = (await commRes.json()).community.id;

    const chanRes = await context.request.post(`/api/v1/communities/${communityId}/channels`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'search-test', is_private: false },
    });
    expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
    channelId = (await chanRes.json()).channel.id;

    // ── Seed a few messages with a unique searchable token ────────────────
    messageToken = uniqueToken();
    for (let i = 0; i < 3; i++) {
      const msgRes = await context.request.post(`/api/v1/channels/${channelId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { content: `${messageToken} message-${i}` },
      });
      expect(msgRes.ok(), `seed message ${i}: ${msgRes.status()}`).toBeTruthy();
      const { message } = await msgRes.json();
      messageIds.push(message.id);
    }
  });

  test.afterAll(async () => {
    // Best-effort cleanup: delete the test community.
    try {
      await context.request.delete(`/api/v1/communities/${communityId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }
    await context?.close();
  });

  test('finds seeded messages by unique token @smoke @full @staging', async () => {
    // Navigate to the channel in the UI.
    await bootstrapPageWithToken(page, token);

    // Open the community in the sidebar (click its icon / item).
    await page.locator(`[data-testid^="community-item-"]`).filter({
      has: page.locator(`[data-community-id="${communityId}"]`),
    }).first().click().catch(() =>
      // Fallback: click any community item that opens our channel.
      page.locator(`[data-testid^="community-item-"]`).first().click()
    );

    // Click the channel in the channel sidebar.
    const channelItem = page.locator(`[data-testid^="channel-item-"]`).filter({ hasText: 'search-test' }).first();
    await expect(channelItem).toBeVisible({ timeout: 15_000 });
    await channelItem.click();

    await expect(page.getByTestId('message-pane')).toBeVisible({ timeout: 10_000 });

    // ── Open search ───────────────────────────────────────────────────────
    const toggleBtn = page.getByTestId('message-search-toggle');
    await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
    await toggleBtn.click();

    const searchInput = page.getByTestId('search-input');
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill(messageToken);

    // The popout shows a "Search for <term>" button — click it to submit.
    const popoutBtn = page.getByTestId('search-popout').locator('button').first();
    await expect(popoutBtn).toBeVisible({ timeout: 5_000 });
    await popoutBtn.click();

    // ── Verify results ────────────────────────────────────────────────────
    const searchBar = page.getByTestId('search-bar');
    await expect(searchBar).toBeVisible({ timeout: 15_000 });

    // All 3 seeded messages should appear.
    const searchResults = page.getByTestId('search-results');
    for (const id of messageIds) {
      await expect(searchResults.locator(`[data-testid="search-hit-${id}"]`)).toBeVisible({ timeout: 10_000 });
    }

    // The summary shows correct count.
    const summary = page.getByTestId('search-summary');
    await expect(summary).toContainText('3');
  });

  test('shows zero-results state for a nonsense query @full @staging', async () => {
    // Re-open search (closes from the previous test when navigating).
    const toggleBtn = page.getByTestId('message-search-toggle');
    if (await toggleBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await toggleBtn.click();
    }

    const searchInput = page.getByTestId('search-input');
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    const noMatchToken = `zzznomatch${Date.now().toString(36)}`;
    await searchInput.fill(noMatchToken);

    const popoutBtn = page.getByTestId('search-popout').locator('button').first();
    await expect(popoutBtn).toBeVisible({ timeout: 5_000 });
    await popoutBtn.click();

    const searchBar = page.getByTestId('search-bar');
    await expect(searchBar).toBeVisible({ timeout: 15_000 });

    // Zero results — the "No results for" message should be shown.
    await expect(searchBar).toContainText('No results');
    await expect(page.getByTestId('search-summary')).toContainText('0 Result');
  });
});
