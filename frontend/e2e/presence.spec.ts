/**
 * Presence display E2E tests.
 *
 * Covers:
 *  - A logged-in user appears as "online" in another member's member list
 *  - A user can set their status to "idle" via the account modal and the
 *    member list reflects the change
 */

import { test, expect } from '@playwright/test';
import { buildUser, bootstrapPageWithToken, registerOrLogin } from './helpers/session';

test.describe('presence display', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test(
    'logged-in user appears online in the member list @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('presA');
      const userB = buildUser('presB');

      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();

      try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        const suffix = Date.now().toString(36);

        // Register both users. A creates the community+channel before either
        // page loads so the community appears in both sidebars on mount.
        const tokenA = await registerOrLogin(ctxA.request, userA);
        const tokenB = await registerOrLogin(ctxB.request, userB);

        const commRes = await ctxA.request.post('/api/v1/communities', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { name: `Presence E2E ${suffix}`, slug: `prese2e${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const { community } = await commRes.json();
        const communityId: string = community.id;
        const userAId: string = community.owner_id;

        // B joins the community before their page loads.
        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join community: ${joinRes.status()}`).toBeTruthy();

        // Load both pages — A's WS connects first, establishing "online" status.
        await bootstrapPageWithToken(pageA, tokenA);

        // Click into the community sidebar so A's WS activity is confirmed.
        await pageA.getByTestId(`community-item-${communityId}`).click();
        await expect(pageA.getByTestId('channel-sidebar')).toBeVisible({ timeout: 15_000 });

        // Now load B's page and navigate to the same community.
        await bootstrapPageWithToken(pageB, tokenB);
        await pageB.getByTestId(`community-item-${communityId}`).click();
        await expect(pageB.getByTestId('member-list')).toBeVisible({ timeout: 15_000 });

        // B's member list must show A as "online".
        // hydratePresenceForUsers polls GET /api/v1/presence for the member IDs.
        const memberRowA = pageB.getByTestId(`member-row-${userAId}`);
        await expect(memberRowA).toBeVisible({ timeout: 20_000 });
        await expect.poll(
          async () => memberRowA.getAttribute('data-member-status'),
          { timeout: 20_000, intervals: [2_000],
            message: `expected member-row-${userAId} to have data-member-status="online"` },
        ).toBe('online');
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );

  test(
    'user can set status to away via account modal @full @staging',
    async ({ browser }) => {
      const user = buildUser('presAway');
      const ctx = await browser.newContext();

      try {
        const page = await ctx.newPage();
        const token = await registerOrLogin(ctx.request, user);
        await bootstrapPageWithToken(page, token);

        // Open the account modal.
        await page.getByTestId('account-open').click();
        const presenceSelect = page.getByTestId('account-presence-status');
        await expect(presenceSelect).toBeVisible({ timeout: 10_000 });

        // The modal fires loadAccount() which calls /auth/oauth/linked and
        // /users/me in parallel. The initial component state is hasPassword=false
        // → "Not configured". When the API resolves it becomes "Configured"
        // (our test users always register with a local password).
        // Waiting for "Configured" is a reliable, zero-arbitrary-delay gate
        // that ensures loadAccount() has fully settled before we interact with
        // the presence select — preventing the API response from overwriting
        // our selectOption('away') call.
        await expect(page.getByText('Configured')).toBeVisible({ timeout: 10_000 });

        // Set presence to "away" (the other user-settable option besides "online").
        // Wait for the controlled <select> to reflect 'away' before saving —
        // on slow/production environments React may not have committed the
        // re-render by the time the next action fires.
        await presenceSelect.selectOption('away');
        await expect(presenceSelect).toHaveValue('away', { timeout: 3_000 });
        await page.getByTestId('account-presence-save').click();

        // The account section shows a confirmation message when the save succeeds.
        // Note: the <p> is a sibling of the form, not inside it.
        await expect(page.locator('p').filter({ hasText: 'Away status updated.' })).toBeVisible(
          { timeout: 10_000 },
        );
      } finally {
        await ctx.close();
      }
    },
  );
});
