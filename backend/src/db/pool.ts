/**
 * Postgres connection pool (singleton).
 * All modules import from here to share the same pool.
 */

'use strict';

const { Pool } = require('pg');
const { pgPoolCheckoutMs } = require('../utils/metrics');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '50', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  require('../utils/logger').error(err, 'Unexpected Postgres pool error');
});

// Wrap pool.connect to measure checkout wait time
const _origConnect = pool.connect.bind(pool);
pool.connect = async function measuredConnect() {
  const start = process.hrtime.bigint();
  const client = await _origConnect();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  pgPoolCheckoutMs.observe(ms);
  return client;
};

module.exports = { pool };
