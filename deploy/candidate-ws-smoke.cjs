#!/usr/bin/env node
/**
 * Pre-cutover synthetic: register → create community → WS subscribe → POST message → receive message:created.
 * Deploy copies this file into the release backend/ so require('ws') uses backend/node_modules.
 *
 * Env: API_CONTRACT_BASE_URL (e.g. http://127.0.0.1:4001/api/v1), API_CONTRACT_WS_URL (ws://127.0.0.1:4001/ws)
 */
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const BASE = (process.env.API_CONTRACT_BASE_URL || '').replace(/\/$/, '');
const WS_URL = (process.env.API_CONTRACT_WS_URL || '').replace(/\/$/, '');

function fail(msg) {
  console.error('candidate-ws-smoke FAIL:', msg);
  process.exit(1);
}

function waitFor(ws, predicate, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    function onMsg(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.removeListener('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

async function main() {
  if (!BASE || !WS_URL) fail('Set API_CONTRACT_BASE_URL and API_CONTRACT_WS_URL');

  const suffix = crypto.randomBytes(5).toString('hex');
  const email = `cws-${suffix}@example.com`;
  const username = `cws_${suffix}`;
  const password = 'CandidateWS!234';
  const marker = `cws-msg-${suffix}`;

  let r = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  });
  if (!r.ok) fail(`register HTTP ${r.status}`);
  const reg = await r.json();
  const accessToken = reg.accessToken;
  if (!accessToken) fail('register response missing accessToken');

  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  r = await fetch(`${BASE}/communities`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ slug: `cws-${suffix}`, name: 'candidate smoke', isPublic: true }),
  });
  if (!r.ok) fail(`create community HTTP ${r.status}`);
  const { community } = await r.json();
  if (!community?.id) fail('missing community id');

  // Retry up to 5× to tolerate read-replica replication lag: the community_members
  // write and the default channel insert on primary may not have replicated by the
  // time queryRead() fires, causing either a 403 or an empty channel list.
  let chJson;
  for (let attempt = 1; attempt <= 5; attempt++) {
    r = await fetch(`${BASE}/channels?communityId=${community.id}`, { headers: auth });
    if (r.ok) {
      chJson = await r.json();
      if ((chJson.channels || []).length > 0) break;
    }
    if (attempt < 5) {
      await new Promise((res) => setTimeout(res, 300 * attempt));
      continue;
    }
    if (!r.ok) fail(`list channels HTTP ${r.status}`);
  }
  const channels = chJson.channels || [];
  const general = channels.find((c) => c.name === 'general') || channels[0];
  if (!general?.id) fail('no channel to post to');

  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(accessToken)}`);
  const opened = new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', resolve);
  });
  const readyP = waitFor(ws, (m) => m.event === 'ready', 20000);
  await opened;
  await readyP;
  ws.send(JSON.stringify({ type: 'subscribe', channel: `channel:${general.id}` }));

  const evtP = waitFor(
    ws,
    (m) => m.event === 'message:created' && String(m.data?.content || '').includes(marker),
    20000,
  );

  r = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ channelId: general.id, content: marker }),
  });
  if (!r.ok) fail(`post message HTTP ${r.status}`);

  await evtP;
  ws.close();
  console.log('candidate-ws-smoke OK');
}

main().catch((err) => fail(err.message || err));
