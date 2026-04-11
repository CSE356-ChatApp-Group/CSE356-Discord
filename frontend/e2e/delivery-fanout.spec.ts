/**
 * Delivery semantics vs grading / throughput probes.
 *
 * External graders (per instructor notes) treat each community member who should
 * receive a message as a separate delivery, with failure if any such listener
 * does not see the message within 15s. Outages roll up bursts of failures
 * (e.g. >50% bad in 10 events or 30s). These tests do not talk to the grader;
 * they give a local signal for fanout, timing, and burst behavior.
 *
 * Scope assumption (confirm with course staff if grading disagrees): we model
 * “should receive” as members who have the target channel open in the message
 * pane (WS subscribed to `channel:<id>`). A member who is in the community but
 * focused on another channel is not expected to see that message in their
 * current pane — see the non-subscribed-channel describe block below.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  buildUser,
  bootstrapPageWithToken,
  registerOrLogin,
} from './helpers/session';

/** Align with grading SLA: each listener must observe the message within this window. */
const GRADING_DELIVERY_MS = 15_000;

async function openPublicChannel(
  p: Page,
  communityId: string,
  channelId: string,
): Promise<void> {
  await p.getByTestId(`community-item-${communityId}`).click();
  await expect(p.getByTestId(`channel-item-${channelId}`)).toBeVisible({
    timeout: 15_000,
  });
  await p.getByTestId(`channel-item-${channelId}`).click();
  await expect(p.getByTestId('message-pane')).toBeVisible({ timeout: 10_000 });
}

async function userIdFromMe(request: APIRequestContext, token: string): Promise<string> {
  const me = await request.get('/api/v1/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(me.ok(), `users/me: ${me.status()}`).toBeTruthy();
  const id = (await me.json()).user?.id as string;
  expect(Boolean(id)).toBeTruthy();
  return id;
}

test.describe('channel delivery fanout (grader-shaped)', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test(
    'one API send is visible to every subscribed listener within 15s @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('fanA');
      const userB = buildUser('fanB');
      const userC = buildUser('fanC');
      const userD = buildUser('fanD');

      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const ctxC = await browser.newContext();
      const ctxD = await browser.newContext();

      try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const pageC = await ctxC.newPage();
        const pageD = await ctxD.newPage();

        const suffix = Date.now().toString(36);

        const tokenA = await registerOrLogin(ctxA.request, userA);
        const tokenB = await registerOrLogin(ctxB.request, userB);
        const tokenC = await registerOrLogin(ctxC.request, userC);
        const tokenD = await registerOrLogin(ctxD.request, userD);

        const commRes = await ctxA.request.post('/api/v1/communities', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { name: `Fanout E2E ${suffix}`, slug: `fanout${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'fanout-chan', isPrivate: false },
        });
        expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        for (const [ctx, t] of [
          [ctxB, tokenB],
          [ctxC, tokenC],
          [ctxD, tokenD],
        ] as const) {
          const joinRes = await ctx.request.post(`/api/v1/communities/${communityId}/join`, {
            headers: { Authorization: `Bearer ${t}` },
          });
          expect(joinRes.ok(), `join community: ${joinRes.status()}`).toBeTruthy();
        }

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
          bootstrapPageWithToken(pageC, tokenC),
          bootstrapPageWithToken(pageD, tokenD),
        ]);

        await Promise.all([
          openPublicChannel(pageA, communityId, channelId),
          openPublicChannel(pageB, communityId, channelId),
          openPublicChannel(pageC, communityId, channelId),
          openPublicChannel(pageD, communityId, channelId),
        ]);

        const messageContent = `fanout ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId, content: messageContent },
        });
        expect(msgRes.ok(), `send message: ${msgRes.status()}`).toBeTruthy();

        const row = (p: Page) =>
          p.locator('[data-message-id]').filter({ hasText: messageContent });

        await Promise.all([
          expect(row(pageA)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
          expect(row(pageB)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
          expect(row(pageC)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
          expect(row(pageD)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
        ]);
      } finally {
        await ctxA.close();
        await ctxB.close();
        await ctxC.close();
        await ctxD.close();
      }
    },
  );

  test(
    'rapid burst of 10 channel messages: receiver sees all rows within 15s of last send @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('burstA');
      const userB = buildUser('burstB');

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
          data: { name: `Burst E2E ${suffix}`, slug: `burst${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'burst-chan', isPrivate: false },
        });
        expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join: ${joinRes.status()}`).toBeTruthy();

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
        ]);

        await openPublicChannel(pageA, communityId, channelId);
        await openPublicChannel(pageB, communityId, channelId);

        const base = Date.now();
        const contents: string[] = [];
        for (let i = 0; i < 10; i += 1) {
          const c = `burst-${base}-${i}`;
          contents.push(c);
          const msgRes = await ctxA.request.post('/api/v1/messages', {
            headers: { Authorization: `Bearer ${tokenA}` },
            data: { channelId, content: c },
          });
          expect(msgRes.ok(), `send ${i}: ${msgRes.status()}`).toBeTruthy();
        }

        const last = contents[contents.length - 1];
        await expect(
          pageB.locator('[data-message-id]').filter({ hasText: last }),
        ).toBeVisible({ timeout: GRADING_DELIVERY_MS });

        for (const c of contents) {
          await expect(
            pageB.locator('[data-message-id]').filter({ hasText: c }),
          ).toBeVisible({ timeout: 5_000 });
        }
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );

  test(
    'private channel: API send reaches every invited listener within 15s @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('privFanA');
      const userB = buildUser('privFanB');
      const userC = buildUser('privFanC');
      const userD = buildUser('privFanD');

      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const ctxC = await browser.newContext();
      const ctxD = await browser.newContext();

      try {
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const pageC = await ctxC.newPage();
        const pageD = await ctxD.newPage();

        const suffix = Date.now().toString(36);

        const tokenA = await registerOrLogin(ctxA.request, userA);
        const tokenB = await registerOrLogin(ctxB.request, userB);
        const tokenC = await registerOrLogin(ctxC.request, userC);
        const tokenD = await registerOrLogin(ctxD.request, userD);

        const idB = await userIdFromMe(ctxB.request, tokenB);
        const idC = await userIdFromMe(ctxC.request, tokenC);
        const idD = await userIdFromMe(ctxD.request, tokenD);

        const commRes = await ctxA.request.post('/api/v1/communities', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { name: `PrivFan E2E ${suffix}`, slug: `privfan${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'priv-fanout', isPrivate: true },
        });
        expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        for (const [ctx, t] of [
          [ctxB, tokenB],
          [ctxC, tokenC],
          [ctxD, tokenD],
        ] as const) {
          const joinRes = await ctx.request.post(`/api/v1/communities/${communityId}/join`, {
            headers: { Authorization: `Bearer ${t}` },
          });
          expect(joinRes.ok(), `join community: ${joinRes.status()}`).toBeTruthy();
        }

        const addRes = await ctxA.request.post(`/api/v1/channels/${channelId}/members`, {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { userIds: [idB, idC, idD] },
        });
        expect(addRes.ok(), `add members: ${addRes.status()}`).toBeTruthy();

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
          bootstrapPageWithToken(pageC, tokenC),
          bootstrapPageWithToken(pageD, tokenD),
        ]);

        await Promise.all([
          openPublicChannel(pageA, communityId, channelId),
          openPublicChannel(pageB, communityId, channelId),
          openPublicChannel(pageC, communityId, channelId),
          openPublicChannel(pageD, communityId, channelId),
        ]);

        const messageContent = `priv-fanout ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId, content: messageContent },
        });
        expect(msgRes.ok(), `send message: ${msgRes.status()}`).toBeTruthy();

        const row = (p: Page) =>
          p.locator('[data-message-id]').filter({ hasText: messageContent });

        await Promise.all([
          expect(row(pageA)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
          expect(row(pageB)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
          expect(row(pageC)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
          expect(row(pageD)).toBeVisible({ timeout: GRADING_DELIVERY_MS }),
        ]);
      } finally {
        await ctxA.close();
        await ctxB.close();
        await ctxC.close();
        await ctxD.close();
      }
    },
  );

  test(
    'listener offline during send still sees message within 15s after network returns @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('recoA');
      const userB = buildUser('recoB');

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
          data: { name: `Reco E2E ${suffix}`, slug: `reco${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chanRes = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'reco-chan', isPrivate: false },
        });
        expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
        const channelId: string = (await chanRes.json()).channel.id;

        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join: ${joinRes.status()}`).toBeTruthy();

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
        ]);

        await openPublicChannel(pageA, communityId, channelId);
        await openPublicChannel(pageB, communityId, channelId);

        await pageB.context().setOffline(true);
        await pageB.waitForTimeout(2_000);

        const messageContent = `reco ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId, content: messageContent },
        });
        expect(msgRes.ok(), `send message: ${msgRes.status()}`).toBeTruthy();

        await pageB.context().setOffline(false);

        await expect(
          pageB.locator('[data-message-id]').filter({ hasText: messageContent }),
        ).toBeVisible({ timeout: GRADING_DELIVERY_MS });
      } finally {
        await ctxB.setOffline(false).catch(() => {});
        await ctxA.close();
        await ctxB.close();
      }
    },
  );
});

test.describe('non-subscribed channel (sanity for listener scope)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test(
    'member in community but on another channel does not see new messages in that pane @full @staging @heavy-auth',
    async ({ browser }) => {
      const userA = buildUser('scopeA');
      const userB = buildUser('scopeB');

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
          data: { name: `Scope E2E ${suffix}`, slug: `scope${suffix}` },
        });
        expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
        const communityId: string = (await commRes.json()).community.id;

        const chan1 = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'scope-alpha', isPrivate: false },
        });
        expect(chan1.ok(), `ch1: ${chan1.status()}`).toBeTruthy();
        const channelId1: string = (await chan1.json()).channel.id;

        const chan2 = await ctxA.request.post('/api/v1/channels', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { communityId, name: 'scope-beta', isPrivate: false },
        });
        expect(chan2.ok(), `ch2: ${chan2.status()}`).toBeTruthy();
        const channelId2: string = (await chan2.json()).channel.id;

        const joinRes = await ctxB.request.post(`/api/v1/communities/${communityId}/join`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        expect(joinRes.ok(), `B join: ${joinRes.status()}`).toBeTruthy();

        await Promise.all([
          bootstrapPageWithToken(pageA, tokenA),
          bootstrapPageWithToken(pageB, tokenB),
        ]);

        await openPublicChannel(pageA, communityId, channelId1);
        await openPublicChannel(pageB, communityId, channelId2);

        const messageContent = `only-in-alpha ${Date.now()}`;
        const msgRes = await ctxA.request.post('/api/v1/messages', {
          headers: { Authorization: `Bearer ${tokenA}` },
          data: { channelId: channelId1, content: messageContent },
        });
        expect(msgRes.ok(), `send: ${msgRes.status()}`).toBeTruthy();

        await expect(
          pageA.locator('[data-message-id]').filter({ hasText: messageContent }),
        ).toBeVisible({ timeout: GRADING_DELIVERY_MS });

        await expect(
          pageB.locator('[data-message-id]').filter({ hasText: messageContent }),
        ).not.toBeVisible({ timeout: 15_000 });
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );
});
