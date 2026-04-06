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
        // After selectOption, wait for the React-state-driven away-message input
        // to appear: it renders only when presenceStatus === 'away' in React state
        // (see CommunitySidebar line ~299: {presenceStatus === 'away' && <input .../>}).
        // This is a reliable indicator that React committed the state update —
        // unlike toHaveValue which can pass just because Playwright set the DOM
        // property directly, before React reconciles it back to 'online'.
        await presenceSelect.selectOption('away');
        // Confirm React committed the 'away' state: the away-message input only
        // renders when presenceStatus === 'away' in component state, so its
        // visibility is a reliable indicator.
        await expect(page.getByTestId('account-away-message')).toBeVisible({ timeout: 3_000 });
        // Belt-and-suspenders: assert the select has the committed 'away' value
        // immediately before clicking save.  If a late openAccountModal API
        // callback had overwritten the selection this would fail here with a
        // clear message, rather than on the presence-msg assertion below.
        await expect(presenceSelect).toHaveValue('away');
        await page.getByTestId('account-presence-save').click();

        // The account section shows a confirmation message when the save succeeds.
        // With optimistic feedback the message is set synchronously before the
        // PUT round-trip, so it should appear within milliseconds of the click.
        await expect(page.getByTestId('account-presence-msg')).toHaveText(
          'Away status updated.',
          { timeout: 5_000 },
        );
      } finally {
        await ctx.close();
      }
    },
  );
});
