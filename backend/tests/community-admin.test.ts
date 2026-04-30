import { request, app } from './runtime';
import { createAuthenticatedUser, uniqueSuffix } from './helpers';

describe('community admin channel controls', () => {
  it('lets an owner promote a member to admin and lets that admin manage channels', async () => {
    const owner = await createAuthenticatedUser('communityadminowner');
    const member = await createAuthenticatedUser('communityadminmember');
    const slug = `community-admin-${uniqueSuffix()}`;

    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'community admin test' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(joinRes.status).toBe(200);

    const promoteRes = await request(app)
      .patch(`/api/v1/communities/${communityId}/members/${member.user.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'admin' });
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.member.role).toBe('admin');

    const createChannelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        communityId,
        name: `admin-ch-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: false,
      });
    expect(createChannelRes.status).toBe(201);
    const channelId = createChannelRes.body.channel.id;

    const makePrivateRes = await request(app)
      .patch(`/api/v1/channels/${channelId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isPrivate: true });
    expect(makePrivateRes.status).toBe(200);
    expect(makePrivateRes.body.channel.is_private).toBe(true);

    const postPrivateMessageRes = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ channelId, content: 'admin private message' });
    expect(postPrivateMessageRes.status).toBe(201);

    const makePublicRes = await request(app)
      .patch(`/api/v1/channels/${channelId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isPrivate: false });
    expect(makePublicRes.status).toBe(200);
    expect(makePublicRes.body.channel.is_private).toBe(false);

    const deleteRes = await request(app)
      .delete(`/api/v1/channels/${channelId}`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(deleteRes.status).toBe(200);
  });

  it('does not let a plain member promote roles or manage channels', async () => {
    const owner = await createAuthenticatedUser('communityadminownerdeny');
    const member = await createAuthenticatedUser('communityadminmemberdeny');
    const slug = `community-admin-deny-${uniqueSuffix()}`;

    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'community admin deny test' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const joinRes = await request(app)
      .post(`/api/v1/communities/${communityId}/join`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(joinRes.status).toBe(200);

    const promoteOwnerRes = await request(app)
      .patch(`/api/v1/communities/${communityId}/members/${owner.user.id}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ role: 'admin' });
    expect(promoteOwnerRes.status).toBe(403);

    const ownerChannelRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        communityId,
        name: `owner-ch-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: false,
      });
    expect(ownerChannelRes.status).toBe(201);
    const channelId = ownerChannelRes.body.channel.id;

    const memberCreateRes = await request(app)
      .post('/api/v1/channels')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        communityId,
        name: `member-ch-${uniqueSuffix()}`.slice(0, 32),
        isPrivate: false,
      });
    expect(memberCreateRes.status).toBe(403);

    const memberPatchRes = await request(app)
      .patch(`/api/v1/channels/${channelId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ isPrivate: true });
    expect(memberPatchRes.status).toBe(403);

    const memberDeleteRes = await request(app)
      .delete(`/api/v1/channels/${channelId}`)
      .set('Authorization', `Bearer ${member.accessToken}`);
    expect(memberDeleteRes.status).toBe(403);
  });

  it('does not expose community members and presence to non-members', async () => {
    const owner = await createAuthenticatedUser('communitymemberlistowner');
    const outsider = await createAuthenticatedUser('communitymemberlistoutsider');
    const slug = `community-member-list-${uniqueSuffix()}`;

    const communityRes = await request(app)
      .post('/api/v1/communities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug, name: slug, description: 'community member list privacy' });
    expect(communityRes.status).toBe(201);
    const communityId = communityRes.body.community.id;

    const membersRes = await request(app)
      .get(`/api/v1/communities/${communityId}/members`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);

    expect(membersRes.status).toBe(403);
  });
});
