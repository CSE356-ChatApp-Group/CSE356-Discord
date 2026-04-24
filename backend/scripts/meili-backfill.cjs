#!/usr/bin/env node
/**
 * npm run meili:backfill
 *
 * Safe, rerunnable backfill: reads non-deleted messages from Postgres
 * in batches and writes them to Meilisearch.
 *
 * Usage:
 *   node scripts/meili-backfill.cjs [options]
 *
 * Options:
 *   --batch-size <n>   Messages per Postgres/Meili batch (default: 500)
 *   --dry-run          Log batches without writing to Meili
 *   --after-id <uuid>  Resume from a specific message UUID (exclusive cursor)
 *   --limit <n>        Stop after indexing this many messages
 *
 * Progress is logged to stdout; exits nonzero on hard failures.
 *
 * Required env: DATABASE_URL, MEILI_HOST, MEILI_MASTER_KEY
 * Optional env: MEILI_INDEX_MESSAGES, MEILI_ENABLED (informational only –
 *               backfill always runs if called explicitly)
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

const { Pool } = require('pg');

const DATABASE_URL = process.env.PGDUMP_DATABASE_URL || process.env.DATABASE_URL;
const MEILI_HOST   = (process.env.MEILI_HOST || '').replace(/\/$/, '');
const MEILI_KEY    = process.env.MEILI_MASTER_KEY || '';
const INDEX        = process.env.MEILI_INDEX_MESSAGES || 'messages';
const MEILI_TIMEOUT_MS = Math.max(10_000, parseInt(process.env.MEILI_TIMEOUT_MS || '15000', 10));

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const BATCH_SIZE = Math.max(1, parseInt(getArg('--batch-size') || '500', 10));
const DRY_RUN    = argv.includes('--dry-run');
const AFTER_ID   = getArg('--after-id') || null;
const LIMIT      = getArg('--limit') ? parseInt(getArg('--limit'), 10) : null;

// ── Guards ────────────────────────────────────────────────────────────────────

if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set.'); process.exit(1); }
if (!MEILI_HOST)   { console.error('ERROR: MEILI_HOST not set.'); process.exit(1); }
if (!MEILI_KEY)    { console.error('ERROR: MEILI_MASTER_KEY not set.'); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function meiliPost(path, body) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), MEILI_TIMEOUT_MS);
  try {
    const res = await fetch(`${MEILI_HOST}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEILI_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Meili POST ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  } finally {
    clearTimeout(tid);
  }
}

function toDoc(row) {
  return {
    id:             String(row.id),
    content:        String(row.content || ''),
    authorId:       String(row.author_id),
    channelId:      row.channel_id   ? String(row.channel_id)   : null,
    communityId:    row.community_id ? String(row.community_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    createdAt:      new Date(row.created_at).getTime(),
    updatedAt:      row.updated_at ? new Date(row.updated_at).getTime() : null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

  console.log('=== Meilisearch backfill ===');
  console.log(`  Host:       ${MEILI_HOST}`);
  console.log(`  Index:      ${INDEX}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log(`  After ID:   ${AFTER_ID || '(start from beginning)'}`);
  console.log(`  Limit:      ${LIMIT ?? 'none'}`);
  console.log('');

  let cursor = AFTER_ID;       // UUID cursor for keyset pagination
  let totalIndexed = 0;
  let totalBatches = 0;
  let hasMore      = true;
  const tStart     = Date.now();

  while (hasMore) {
    if (LIMIT !== null && totalIndexed >= LIMIT) break;

    const batchSize = LIMIT !== null
      ? Math.min(BATCH_SIZE, LIMIT - totalIndexed)
      : BATCH_SIZE;

    // Keyset pagination on (created_at ASC, id ASC) – stable even under concurrent inserts.
    const { rows } = await pool.query(
      `SELECT
         m.id,
         m.content,
         m.author_id,
         m.channel_id,
         m.conversation_id,
         ch.community_id,
         m.created_at,
         m.updated_at
       FROM messages m
       LEFT JOIN channels ch ON ch.id = m.channel_id
       WHERE m.deleted_at IS NULL
         ${cursor ? 'AND (m.created_at, m.id) > (SELECT created_at, id FROM messages WHERE id = $2::uuid)' : ''}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $1`,
      cursor ? [batchSize, cursor] : [batchSize],
    );

    if (rows.length === 0) { hasMore = false; break; }

    const docs = rows.map(toDoc);
    cursor     = rows[rows.length - 1].id;

    if (DRY_RUN) {
      console.log(`[dry-run] batch ${totalBatches + 1}: ${docs.length} docs (last id: ${cursor})`);
    } else {
      const result = await meiliPost(`/indexes/${INDEX}/documents`, docs);
      console.log(
        `batch ${totalBatches + 1}: indexed ${docs.length} docs (taskUid: ${result.taskUid ?? '-'}, last id: ${cursor})`,
      );
    }

    totalIndexed += docs.length;
    totalBatches++;

    if (rows.length < batchSize) hasMore = false;
  }

  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('');
  console.log(`✅ Done. Indexed ${totalIndexed} messages in ${totalBatches} batches (${elapsedSec}s)`);
  if (DRY_RUN) console.log('   (dry-run: no documents were written to Meilisearch)');

  await pool.end();
}

main().catch((err) => { console.error('backfill FAILED:', err); process.exit(1); });
