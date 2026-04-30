#!/usr/bin/env node
/**
 * Register a user, create a community + public channel; print TOKEN and CHANNEL_ID for burst scripts.
 * Expects API reachable from the host (e.g. docker compose with nginx on :80).
 *
 *   BASE_URL=http://localhost/api/v1 node scripts/load/local-api-seed-channel.mjs
 */
const base = (process.env.BASE_URL || 'http://localhost/api/v1').replace(/\/$/, '');
const pw = process.env.SEED_PASSWORD || 'Password1!';
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const username = `burst${stamp}`.slice(0, 32);
const email = `burst-${stamp}@example.com`;

async function j(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.body = data;
    throw err;
  }
  return data;
}

async function main() {
  const reg = await j('POST', '/auth/register', {
    email,
    username,
    password: pw,
    displayName: username,
  });
  const token = reg.accessToken;
  if (!token) throw new Error('No accessToken from register');

  const slug = `b${stamp}`.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || `b${stamp}`;
  const comm = await j(
    'POST',
    '/communities',
    { slug, name: slug, description: 'hot-channel e2e' },
    token,
  );
  const communityId = comm.community?.id;
  if (!communityId) throw new Error('No community id');

  const chan = await j(
    'POST',
    '/channels',
    {
      communityId,
      name: `ch-${stamp}`.slice(0, 32),
      isPrivate: false,
    },
    token,
  );
  const channelId = chan.channel?.id;
  if (!channelId) throw new Error('No channel id');

  process.stdout.write(
    JSON.stringify(
      {
        BASE_URL: base,
        TOKEN: token,
        CHANNEL_ID: channelId,
        USER_ID: reg.user?.id,
        COMMUNITY_ID: communityId,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((e) => {
  console.error(e.message, e.body || '');
  process.exit(1);
});
