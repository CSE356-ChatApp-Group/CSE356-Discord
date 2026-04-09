#!/usr/bin/env node
/**
 * SQL migration runner (plain Node, no tsx/esbuild).
 * Keep logic aligned with src/db/migrate.ts shim that loads this file in production builds.
 *
 * Migrations directory: MIGRATIONS_DIR env, else ../../migrations from this file
 * (repo root when cwd is backend).
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
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

      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');

      console.log(`[done]  ${file}`);
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
