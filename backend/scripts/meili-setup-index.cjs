#!/usr/bin/env node
/**
 * npm run meili:setup-index
 *
 * Creates the messages index in Meilisearch and configures:
 *   - searchableAttributes: [content]
 *   - filterableAttributes: [authorId, channelId, communityId, conversationId, createdAt]
 *   - sortableAttributes:   [createdAt]
 *
 * Safe to rerun (idempotent).
 *
 * Required env:
 *   MEILI_HOST         e.g. http://10.0.0.146:7700
 *   MEILI_MASTER_KEY   master/API key
 *
 * Optional:
 *   MEILI_INDEX_MESSAGES   default: messages
 *   MEILI_TIMEOUT_MS       default: 5000
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const backendEnv = path.join(__dirname, '..', '.env');
const rootEnv    = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(backendEnv)) {
  require('dotenv').config({ path: backendEnv });
} else if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv });
} else {
  require('dotenv').config();
}

const MEILI_HOST  = (process.env.MEILI_HOST || '').replace(/\/$/, '');
const MEILI_KEY   = process.env.MEILI_MASTER_KEY || '';
const INDEX       = process.env.MEILI_INDEX_MESSAGES || 'messages';
const TIMEOUT_MS  = parseInt(process.env.MEILI_TIMEOUT_MS || '5000', 10);

if (!MEILI_HOST || !MEILI_KEY) {
  console.error('ERROR: MEILI_HOST and MEILI_MASTER_KEY must be set.');
  process.exit(1);
}

async function req(path, method, body) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MEILI_HOST}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  } finally {
    clearTimeout(tid);
  }
}

async function main() {
  console.log(`Meilisearch host: ${MEILI_HOST}`);
  console.log(`Index:            ${INDEX}`);

  // 1 – Health check
  console.log('\n1) Health check...');
  const health = await req('/health', 'GET');
  if (health.body?.status !== 'available') {
    console.error('ERROR: Meilisearch is not healthy:', health.body);
    process.exit(1);
  }
  console.log('   OK – status:', health.body.status);

  // 2 – Create index
  console.log(`\n2) Creating index '${INDEX}'...`);
  const create = await req('/indexes', 'POST', { uid: INDEX, primaryKey: 'id' });
  if (create.status === 409) {
    console.log('   Already exists (409) – skipping create.');
  } else if (create.status >= 400) {
    console.error('ERROR creating index:', create.body);
    process.exit(1);
  } else {
    console.log('   Created (taskUid:', create.body?.taskUid, ')');
  }

  // 3 – Searchable attributes
  console.log('\n3) Setting searchableAttributes...');
  const sa = await req(`/indexes/${INDEX}/settings/searchable-attributes`, 'PUT', ['content']);
  if (sa.status >= 400) { console.error('ERROR:', sa.body); process.exit(1); }
  console.log('   OK (taskUid:', sa.body?.taskUid, ')');

  // 4 – Filterable attributes
  console.log('\n4) Setting filterableAttributes...');
  const fa = await req(`/indexes/${INDEX}/settings/filterable-attributes`, 'PUT', [
    'authorId', 'channelId', 'communityId', 'conversationId', 'createdAt',
  ]);
  if (fa.status >= 400) { console.error('ERROR:', fa.body); process.exit(1); }
  console.log('   OK (taskUid:', fa.body?.taskUid, ')');

  // 5 – Sortable attributes
  console.log('\n5) Setting sortableAttributes...');
  const sort = await req(`/indexes/${INDEX}/settings/sortable-attributes`, 'PUT', ['createdAt']);
  if (sort.status >= 400) { console.error('ERROR:', sort.body); process.exit(1); }
  console.log('   OK (taskUid:', sort.body?.taskUid, ')');

  console.log('\n✅ Index setup complete.');
}

main().catch((err) => { console.error(err); process.exit(1); });
