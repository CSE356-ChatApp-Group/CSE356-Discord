import { request, app } from './runtime';
import { uniqueSuffix, createAuthenticatedUser } from './helpers';

jest.mock('../src/search/opensearchWrite', () => ({
  dualWriteIndexMessage: jest.fn().mockRejectedValue(new Error('opensearch write failed')),
  dualWriteDeleteMessage: jest.fn().mockRejectedValue(new Error('opensearch delete failed')),
}));

describe('OpenSearch dual-write fail-open', () => {
  it('does not fail POST /messages when OpenSearch dual-write throws', async () => {
    const owner = await createAuthenticatedUser('opensearch-dual-write-owner');
    const slug = `osdw-${uniqueSuffix()}`.slice(0, 32);
    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'dual write test' });
    expect(communityRes.status).toBe(201);

    const channelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId: communityRes.body.community.id,
        name: `osdw-ch-${uniqueSuffix()}`.slice(0, 32),
        description: '',
      });
    expect(channelRes.status).toBe(201);

    const msgRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ channelId: channelRes.body.channel.id, content: 'dual write fail-open content' });

    expect(msgRes.status).toBe(201);
    expect(msgRes.body?.message?.id).toBeTruthy();
  });
});
