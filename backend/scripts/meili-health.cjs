#!/usr/bin/env node
/**
 * npm run meili:health
 *
 * Checks Meilisearch health and messages index availability.
 * Exits 0 when healthy, 1 otherwise.
 *
 * --fail-if-disabled  Exit 1 when MEILI_ENABLED is not 'true' (useful in CI
 *                     when SEARCH_BACKEND=meili is required).
 * --json              Print a JSON summary instead of human-readable lines.
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

const MEILI_HOST      = (process.env.MEILI_HOST || '').replace(/\/$/, '');
const MEILI_KEY       = process.env.MEILI_MASTER_KEY || '';
const INDEX           = process.env.MEILI_INDEX_MESSAGES || 'messages';
const MEILI_ENABLED   = String(process.env.MEILI_ENABLED || '').toLowerCase() === 'true';
const SEARCH_BACKEND  = (process.env.SEARCH_BACKEND || 'postgres').toLowerCase();
const TIMEOUT_MS      = 5000;

const args            = process.argv.slice(2);
const failIfDisabled  = args.includes('--fail-if-disabled');
const asJson          = args.includes('--json');

async function req(path, method) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MEILI_HOST}${path}`, {
      method: method || 'GET',
      headers: { Authorization: `Bearer ${MEILI_KEY}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  } catch (err) {
    return { status: 0, body: {}, error: String(err?.message || err) };
  } finally {
    clearTimeout(tid);
  }
}

async function main() {
  const result = {
    meili_enabled: MEILI_ENABLED,
    search_backend: SEARCH_BACKEND,
    meili_host: MEILI_HOST || '(not set)',
    health_ok: false,
    health_status: 'unchecked',
    index_ok: false,
    index_uid: null,
    errors: [],
  };

  if (!MEILI_HOST || !MEILI_KEY) {
    result.errors.push('MEILI_HOST and/or MEILI_MASTER_KEY not set');
    if (asJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.error('ERROR: MEILI_HOST and MEILI_MASTER_KEY must be set to check Meili.'); }
    if (SEARCH_BACKEND === 'meili') { process.exit(1); }
    process.exit(0);
  }

  const health = await req('/health');
  result.health_ok     = health.body?.status === 'available';
  result.health_status = health.body?.status ?? health.error ?? 'unknown';

  const idx = await req(`/indexes/${INDEX}`);
  result.index_ok  = Boolean(idx.body?.uid);
  result.index_uid = idx.body?.uid ?? null;
  if (!result.index_ok) result.errors.push(idx.error || `index '${INDEX}' not found`);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`search_backend : ${result.search_backend}`);
    console.log(`meili_enabled  : ${result.meili_enabled}`);
    console.log(`meili_host     : ${result.meili_host}`);
    console.log(`health         : ${result.health_ok ? '✅' : '❌'} ${result.health_status}`);
    console.log(`index '${INDEX}': ${result.index_ok ? '✅ exists' : '❌ missing'}`);
    if (result.errors.length) console.log('errors:', result.errors.join(', '));
  }

  const deployRequiresMeili = SEARCH_BACKEND === 'meili';
  if (failIfDisabled && !MEILI_ENABLED) {
    console.error('FAIL: MEILI_ENABLED is not true (--fail-if-disabled)');
    process.exit(1);
  }
  if (deployRequiresMeili && (!result.health_ok || !result.index_ok)) {
    console.error('FAIL: SEARCH_BACKEND=meili but Meilisearch is not healthy/index missing.');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
