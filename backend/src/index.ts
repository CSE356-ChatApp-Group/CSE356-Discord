/**
 * ChatApp MVP – Entry point
 *
 * Starts the Express HTTP server and attaches the WebSocket upgrade handler
 * on the same port so a single ingress rule covers both REST and WS traffic.
 */

'use strict';

require('dotenv').config();
// OTel must be the first non-env require so it can patch async context
require('./utils/tracer');

const http     = require('http');
const app      = require('./app');
const wsServer = require('./websocket/server');
const logger   = require('./utils/logger');
const { pool } = require('./db/pool');
const redis    = require('./db/redis');
const { startPgPoolMetrics } = require('./utils/metrics');

const PORT = process.env.PORT || 3000;
let server;
let shuttingDown = false;

async function shutdown(signal, err = null) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (err) {
    logger.fatal({ err, signal }, 'Fatal runtime error; shutting down');
  } else {
    logger.info({ signal }, 'Shutting down…');
  }

  const forceExitTimer = setTimeout(() => {
    logger.error({ signal }, 'Forced shutdown after timeout');
    process.exit(err ? 1 : 0);
  }, 10_000);
  forceExitTimer.unref();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await Promise.allSettled([
    pool.end(),
    redis.quit(),
  ]);

  clearTimeout(forceExitTimer);
  process.exit(err ? 1 : 0);
}

async function start() {
  // Verify DB connectivity before accepting traffic
  await pool.query('SELECT 1');
  logger.info('Postgres connected');

  startPgPoolMetrics(pool);

  await redis.ping();
  logger.info('Redis connected');

  server = http.createServer(app);

  // keepAliveTimeout must be > nginx keepalive_timeout (75s) to prevent EOF
  // race where nginx reuses a connection Node already closed.
  server.keepAliveTimeout = 90_000;
  server.headersTimeout   = 95_000;

  // Attach WebSocket upgrade handler to the same HTTP server
  server.on('upgrade', wsServer.handleUpgrade);

  server.listen({ port: PORT, backlog: 4096 }, () => {
    logger.info({ port: PORT }, 'ChatApp API listening');
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // Transient pg-pool errors (checkout timeout or stale connection terminated by a network device)
    // are per-request failures, not server-fatal events — log and continue.
    if (
      err.message?.includes('timeout exceeded when trying to connect') ||
      err.message?.includes('Connection terminated') ||
      err.message?.includes('connection timeout')
    ) {
      logger.error({ err }, 'pg-pool transient error (unhandled); request failed without response');
      return;
    }
    shutdown('unhandledRejection', err);
  });
  process.on('uncaughtException', (err) => {
    shutdown('uncaughtException', err);
  });
}

start().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
