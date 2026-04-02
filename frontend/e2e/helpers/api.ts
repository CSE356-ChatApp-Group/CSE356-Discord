import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Creates a direct (non-invite) conversation between the authenticated user
 * and `participantUsername`. Returns the conversation ID.
 *
 * Unlike the invite flow, participants added here join immediately — no pending
 * invite state is created. The conversation will appear in the creator's DM
 * list on the next fetchConversations() call.
 */
export async function createDirectConversation(
  request: APIRequestContext,
  participantUsername: string,
): Promise<string> {
  const res = await request.post('/api/v1/conversations', {
    data: { participantIds: [participantUsername] },
  });
  expect(res.ok(), `createDirectConversation failed (${res.status()})`).toBeTruthy();
  const body = await res.json();
  const id: string | undefined = body?.conversation?.id;
  expect(Boolean(id), 'conversation.id missing from response').toBeTruthy();
  return id!;
}

/**
 * Creates a community via API. Returns the community ID.
 */
export async function createCommunity(
  request: APIRequestContext,
  name: string,
  slug: string,
): Promise<string> {
  const res = await request.post('/api/v1/communities', {
    data: { name, slug, isPublic: true },
  });
  expect(res.ok(), `createCommunity failed (${res.status()})`).toBeTruthy();
  const body = await res.json();
  const id: string | undefined = body?.community?.id;
  expect(Boolean(id), 'community.id missing from response').toBeTruthy();
  return id!;
}

/**
 * Creates a public channel inside a community. Returns the channel ID.
 */
export async function createChannel(
  request: APIRequestContext,
  communityId: string,
  name: string,
): Promise<string> {
  const res = await request.post('/api/v1/channels', {
    data: { communityId, name, isPrivate: false },
  });
  expect(res.ok(), `createChannel failed (${res.status()})`).toBeTruthy();
  const body = await res.json();
  const id: string | undefined = body?.channel?.id;
  expect(Boolean(id), 'channel.id missing from response').toBeTruthy();
  return id!;
}
