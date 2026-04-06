/**
 * Attachment E2E tests — hit the real staging stack (nginx → Express → MinIO).
 *
 * All tests use the API directly via context.request so they can run in any
 * environment where the backend is reachable (no browser UI needed for the
 * object-storage flow). A final UI smoke test exercises the attach button.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { buildUser, bootstrapPageWithToken, ensureAuthenticated, registerOrLogin } from './helpers/session';

// Minimal 67-byte 1×1 white PNG — enough to satisfy image/png content-type.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ' +
  'AABjkB6QAAAABJRU5ErkJggg==';

function tinyPngBuffer(): Buffer {
  return Buffer.from(TINY_PNG_B64, 'base64');
}

test.describe('attachment upload and access', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let aliceToken: string;
  let bobCtx: BrowserContext;
  let bobToken: string;

  let communityId: string;
  let channelId: string;
  let messageId: string;
  let attachmentId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);

    const alice = buildUser('alice');
    const bob = buildUser('bob');

    aliceCtx = await browser.newContext();
    alicePage = await aliceCtx.newPage();
    aliceToken = await ensureAuthenticated(aliceCtx, alicePage, alice);

    bobCtx = await browser.newContext();
    bobToken = await registerOrLogin(bobCtx.request, bob);

    // ── Community + channel (Alice is owner + member) ─────────────────────
    const suffix = Date.now().toString(36);
    const commRes = await aliceCtx.request.post('/api/v1/communities', {
      headers: { Authorization: `Bearer ${aliceToken}` },
      data: { name: `Attach E2E ${suffix}`, slug: `atche2e${suffix}` },
    });
    expect(commRes.ok(), `create community: ${commRes.status()}`).toBeTruthy();
    communityId = (await commRes.json()).community.id;

    const chanRes = await aliceCtx.request.post('/api/v1/channels', {
      headers: { Authorization: `Bearer ${aliceToken}` },
      data: { communityId, name: 'attach-test', isPrivate: true },
    });
    expect(chanRes.ok(), `create channel: ${chanRes.status()}`).toBeTruthy();
    channelId = (await chanRes.json()).channel.id;

    // ── Message authored by Alice ─────────────────────────────────────────
    const msgRes = await aliceCtx.request.post('/api/v1/messages', {
      headers: { Authorization: `Bearer ${aliceToken}` },
      data: { channelId, content: 'attachment test message' },
    });
    expect(msgRes.ok(), `create message: ${msgRes.status()}`).toBeTruthy();
    messageId = (await msgRes.json()).message.id;
  });

  test.afterAll(async () => {
    try {
      await aliceCtx.request.delete(`/api/v1/communities/${communityId}`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
    } catch { /* ignore */ }
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  // ── 1. Full presign → upload → record → download flow ────────────────────
  test('presign → PUT → record → signed download URL @smoke @full @staging', async () => {
    // Step 1: get presigned PUT URL
    const presignRes = await aliceCtx.request.post('/api/v1/attachments/presign', {
      headers: { Authorization: `Bearer ${aliceToken}` },
      data: { filename: 'test.png', contentType: 'image/png', sizeBytes: tinyPngBuffer().length },
    });
    expect(presignRes.status(), 'presign should return 200').toBe(200);

    const { uploadUrl, storageKey } = await presignRes.json();
    expect(typeof uploadUrl).toBe('string');
    expect(typeof storageKey).toBe('string');
    expect(storageKey).toMatch(/^uploads\//);
    expect(storageKey).toMatch(/\.png$/);

    // Step 2: upload the file directly to MinIO via the presigned URL.
    // The URL passes through nginx (/minio/ prefix) to MinIO — this validates
    // the full nginx proxy + MinIO presigned-URL round-trip.
    const uploadRes = await aliceCtx.request.put(uploadUrl, {
      data: tinyPngBuffer(),
      headers: { 'Content-Type': 'image/png' },
    });
    expect(uploadRes.status(), `PUT to MinIO: expected 200, got ${uploadRes.status()}`).toBe(200);

    // Step 3: record the attachment metadata.
    const recordRes = await aliceCtx.request.post('/api/v1/attachments', {
      headers: { Authorization: `Bearer ${aliceToken}` },
      data: {
        messageId,
        storageKey,
        filename: 'test.png',
        contentType: 'image/png',
        sizeBytes: tinyPngBuffer().length,
        width: 1,
        height: 1,
      },
    });
    expect(recordRes.status(), `record attachment: ${recordRes.status()}`).toBe(201);

    const { attachment } = await recordRes.json();
    expect(attachment.id).toBeTruthy();
    expect(attachment.storage_key).toBe(storageKey);
    attachmentId = attachment.id;

    // Step 4: fetch the signed download URL as Alice (channel member).
    const getRes = await aliceCtx.request.get(`/api/v1/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(getRes.status(), `GET attachment as owner: ${getRes.status()}`).toBe(200);

    const { attachment: fetched, url: signedUrl } = await getRes.json();
    expect(fetched.id).toBe(attachmentId);
    expect(typeof signedUrl).toBe('string');
    expect(signedUrl).toMatch(/^https?:\/\//);
    // Channel/conversation IDs must NOT be leaked in the response.
    expect(fetched.channel_id).toBeUndefined();
    expect(fetched.conversation_id).toBeUndefined();
  });

  // ── 2. Non-member is blocked (BOLA fix verification) ─────────────────────
  test('returns 403 to a user outside the channel @full @staging', async () => {
    // Bob is not a member of the community/channel Alice created.
    const getRes = await bobCtx.request.get(`/api/v1/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(getRes.status(), 'non-member should get 403').toBe(403);
  });

  // ── 3. Wrong-owner record is blocked (IDOR fix verification) ─────────────
  test('returns 403 when recording against another user\'s message @full @staging', async () => {
    // Bob tries to record an attachment against Alice's message.
    const presignRes = await bobCtx.request.post('/api/v1/attachments/presign', {
      headers: { Authorization: `Bearer ${bobToken}` },
      data: { filename: 'bob.png', contentType: 'image/png', sizeBytes: 100 },
    });
    expect(presignRes.ok()).toBeTruthy();
    const { storageKey } = await presignRes.json();

    const recordRes = await bobCtx.request.post('/api/v1/attachments', {
      headers: { Authorization: `Bearer ${bobToken}` },
      data: {
        messageId,           // Alice's message
        storageKey,
        filename: 'bob.png',
        contentType: 'image/png',
        sizeBytes: 100,
      },
    });
    expect(recordRes.status(), 'should be 403 for wrong owner').toBe(403);
  });

  // ── 4. UI smoke: attach button shows preview before send ─────────────────
  test('attach button accepts an image and shows a preview @smoke @full @staging', async () => {
    await bootstrapPageWithToken(alicePage, aliceToken);

    // Navigate to the community and channel.
    const communityItem = alicePage
      .locator(`[data-testid^="community-item-"]`)
      .first();
    // Give the sidebar time to load communities.
    await expect(communityItem).toBeVisible({ timeout: 15_000 });
    await communityItem.click();

    const channelItem = alicePage
      .locator(`[data-testid^="channel-item-"]`)
      .filter({ hasText: 'attach-test' })
      .first();
    await expect(channelItem).toBeVisible({ timeout: 10_000 });
    await channelItem.click();

    await expect(alicePage.getByTestId('message-pane')).toBeVisible({ timeout: 10_000 });

    // Intercept the file chooser triggered by the attach button.
    const [fileChooser] = await Promise.all([
      alicePage.waitForEvent('filechooser', { timeout: 5_000 }),
      alicePage.getByTestId('message-attach-button').click(),
    ]);

    // Provide a minimal PNG as a named buffer (no real file needed).
    await fileChooser.setFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: tinyPngBuffer(),
    });

    // Preview row appears with the first attachment.
    await expect(alicePage.getByTestId('message-attachment-previews')).toBeVisible({ timeout: 5_000 });
    await expect(alicePage.getByTestId('message-attachment-remove-0')).toBeVisible({ timeout: 5_000 });
  });
});
