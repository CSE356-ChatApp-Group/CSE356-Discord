#!/usr/bin/env node
/**
 * SQL migration runner (plain Node, no tsx/esbuild).
 * Keep logic aligned with src/db/migrate.ts shim that loads this file in production builds.
 *
 * Migrations directory: MIGRATIONS_DIR env, else ../../migrations from this file
 * (repo root when cwd is backend).
 */

'use strict';

const path = require('path');
const fs = require('fs');

// When you run `npm run migrate` from `backend/`, dotenv's default only loads `backend/.env`.
// This repo keeps secrets in the repo-root `.env`; load it if `backend/.env` is missing.
const backendEnv = path.join(__dirname, '..', '.env');
const rootEnv = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(backendEnv)) {
  require('dotenv').config({ path: backendEnv });
} else if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv });
} else {
  require('dotenv').config();
}
const { Pool } = require('pg');

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.join(__dirname, '../../migrations');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Production deploys run with a low role-level statement_timeout on the
    // app user. Disable it for the migration session before we touch the
    // schema_migrations table or advisory lock so deploys do not fail before
    // reaching the per-migration transaction guard below.
    await client.query('SET statement_timeout = 0');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('SELECT pg_advisory_lock(5432100)');

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !f.startsWith('.'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[skip]  ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[apply] ${file}`);

      // Files starting with `-- no-transaction` contain statements that are
      // incompatible with an explicit transaction block (e.g. CREATE INDEX
      // CONCURRENTLY). Run them directly on the connection without BEGIN/COMMIT.
      // The schema_migrations insert is still done inside its own short
      // transaction immediately after so the record is atomic.
      const noTx = /^--\s*no-transaction\b/i.test(sql.trimStart());
      if (noTx) {
        await client.query('SET statement_timeout = 0');
        await client.query(sql);
        await client.query('BEGIN');
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } else {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      }

      console.log(`[done]  ${file}`);
      if (noTx) console.log(`        (ran outside transaction — contained CONCURRENTLY or DDL incompatible with tx)`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().then(() => {
  if (process.exitCode) process.exit(process.exitCode);
});
