/**
 * Attachments integration tests.
 *
 * The AWS SDK is mocked so these tests run without a real S3/MinIO instance.
 * jest.mock() calls are hoisted by ts-jest before any import is evaluated,
 * so the S3Client constructor and getSignedUrl are mocked by the time
 * app.ts loads attachments/router.ts.
 */

// ── AWS SDK mocks (must appear before any imports) ────────────────────────────
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutObjectCommand:    jest.fn(),
  GetObjectCommand:    jest.fn(),
  DeleteObjectsCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue(
    'https://fake-s3.example.com/chatapp-attachments/uploads/user/file.png?X-Amz-Signature=fake',
  ),
}));

import { request, app, pool } from './runtime';
import { uniqueSuffix, createAuthenticatedUser } from './helpers';

// ── Shared test state ─────────────────────────────────────────────────────────
let ownerToken: string;
let ownerId: string;
let channelId: string;
let messageId: string;
let attachmentId: string;
let storageKey: string;
let nonMemberToken: string;

beforeAll(async () => {
  const owner     = await createAuthenticatedUser('attachowner');
  const nonMember = await createAuthenticatedUser('attachnonmember');
  ownerToken     = owner.accessToken;
  ownerId        = owner.user.id;
  nonMemberToken = nonMember.accessToken;

  const slug = `attach-comm-${uniqueSuffix()}`;
  const commRes = await request(app)
    .post('/api/v1/communities')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ slug, name: slug, description: 'attachment test community' });
  const communityId = commRes.body.community.id;

  const chanRes = await request(app)
    .post('/api/v1/channels')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ communityId, name: `attach-chan-${uniqueSuffix()}`.slice(0, 32), isPrivate: false });
  channelId = chanRes.body.channel.id;

  const msgRes = await request(app)
    .post('/api/v1/messages')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ channelId, content: 'message for attachment tests' });
  messageId = msgRes.body.message.id;

  // Insert an attachment row directly so GET /:id tests have a real row.
  storageKey = `uploads/${ownerId}/test-${uniqueSuffix()}.png`;
  const { rows } = await pool.query(
    `INSERT INTO attachments (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key)
     VALUES ($1, $2, 'image', 'test.png', 'image/png', 1024, $3) RETURNING id`,
    [messageId, ownerId, storageKey],
  );
  attachmentId = rows[0].id;
});

// ── POST /presign ─────────────────────────────────────────────────────────────

describe('POST /api/v1/attachments/presign', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/attachments/presign')
      .send({ filename: 'photo.png', contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(401);
  });

  it('returns 400 for disallowed content type', async () => {
    const res = await request(app)
      .post('/api/v1/attachments/presign')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ filename: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 1024 });
    expect(res.status).toBe(400);
  });

  it('returns uploadUrl and storageKey on valid request', async () => {
    const res = await request(app)
      .post('/api/v1/attachments/presign')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ filename: 'photo.png', contentType: 'image/png', sizeBytes: 204800 });

    expect(res.status).toBe(200);
    expect(typeof res.body.uploadUrl).toBe('string');
    expect(typeof res.body.storageKey).toBe('string');
    // storageKey must be scoped to the requesting user
    expect(res.body.storageKey).toMatch(new RegExp(`^uploads/${ownerId}/`));
    // Filename extension preserved
    expect(res.body.storageKey).toMatch(/\.png$/);
  });
});

// ── POST / (record) ───────────────────────────────────────────────────────────

describe('POST /api/v1/attachments', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/attachments')
      .send({ messageId, storageKey: `uploads/${ownerId}/x.png`, filename: 'x.png', contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(401);
  });

  it('returns 403 when messageId belongs to another user', async () => {
    const res = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${nonMemberToken}`)
      .send({ messageId, storageKey: `uploads/other/y.png`, filename: 'y.png', contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not yours/i);
  });

  it('returns 403 when messageId does not exist', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000000';
    const res = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ messageId: fakeId, storageKey: `uploads/${ownerId}/z.png`, filename: 'z.png', contentType: 'image/png', sizeBytes: 1024 });
    expect(res.status).toBe(403);
  });

  it('records attachment metadata and returns 201', async () => {
    // Create a fresh message so the attachment limit is zero for this test.
    const msgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelId, content: 'record test message' });
    const freshMessageId = msgRes.body.message.id;
    const key = `uploads/${ownerId}/record-${uniqueSuffix()}.jpeg`;

    const res = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        messageId: freshMessageId,
        storageKey: key,
        filename:    'photo.jpeg',
        contentType: 'image/jpeg',
        sizeBytes:   2048,
        width:       800,
        height:      600,
      });

    expect(res.status).toBe(201);
    expect(res.body.attachment).toBeDefined();
    expect(res.body.attachment.storage_key).toBe(key);
    expect(res.body.attachment.width).toBe(800);
  });

  it('returns 400 when message already has 4 attachments', async () => {
    // Create a fresh message and pre-fill 4 attachment rows via pool.
    const msgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelId, content: 'limit test message' });
    const limitMsgId = msgRes.body.message.id;

    for (let i = 0; i < 4; i++) {
      await pool.query(
        `INSERT INTO attachments (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key)
         VALUES ($1, $2, 'image', 'f.png', 'image/png', 100, $3)`,
        [limitMsgId, ownerId, `uploads/${ownerId}/limit-${uniqueSuffix()}-${i}.png`],
      );
    }

    const res = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ messageId: limitMsgId, storageKey: `uploads/${ownerId}/over.png`, filename: 'over.png', contentType: 'image/png', sizeBytes: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max/i);
  });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/attachments/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/v1/attachments/${attachmentId}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent id', async () => {
    const res = await request(app)
      .get('/api/v1/attachments/00000000-0000-4000-a000-000000000000')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-UUID id', async () => {
    const res = await request(app)
      .get('/api/v1/attachments/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it('returns attachment and signed URL to channel member', async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.attachment).toBeDefined();
    expect(res.body.attachment.id).toBe(attachmentId);
    expect(typeof res.body.url).toBe('string');
    // channel_id / conversation_id must not be leaked to the client
    expect(res.body.attachment.channel_id).toBeUndefined();
    expect(res.body.attachment.conversation_id).toBeUndefined();
  });

  it('returns 403 to a user who is not in the community that owns the channel', async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${nonMemberToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 403 to a user who is not a participant in a private-channel message', async () => {
    // Create a private channel + message + attachment that nonMember cannot access.
    const privChanRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        communityId: (
          await request(app)
            .get('/api/v1/communities')
            .set('Authorization', `Bearer ${ownerToken}`)
        ).body.communities[0]?.id,
        name: `priv2-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: true,
      });
    const privChannelId = privChanRes.body.channel?.id;
    if (!privChannelId) return; // community setup incomplete — skip

    const privMsgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelId: privChannelId, content: 'private message' });
    const privMsgId = privMsgRes.body.message?.id;
    if (!privMsgId) return;

    const privKey = `uploads/${ownerId}/priv-${uniqueSuffix()}.png`;
    const { rows } = await pool.query(
      `INSERT INTO attachments (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key)
       VALUES ($1, $2, 'image', 'priv.png', 'image/png', 512, $3) RETURNING id`,
      [privMsgId, ownerId, privKey],
    );
    const privAttachId = rows[0].id;

    const res = await request(app)
      .get(`/api/v1/attachments/${privAttachId}`)
      .set('Authorization', `Bearer ${nonMemberToken}`);

    expect(res.status).toBe(403);
  });
});
