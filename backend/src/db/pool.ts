/**
 * Postgres connection pool (singleton).
 * All modules import from here to share the same pool.
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '50', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Send TCP keepalive probes on idle connections so NAT/firewall mappings stay
  // alive and the pool gets fast notification when a connection is silently dropped
  // rather than discovering it mid-request as "Connection terminated unexpectedly".
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

pool.on('error', (err) => {
  require('../utils/logger').error(err, 'Unexpected Postgres pool error');
});

module.exports = { pool };
