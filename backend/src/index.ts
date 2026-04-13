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
const { pool, query: dbQuery, poolStats } = require('./db/pool');
const redis    = require('./db/redis');
const { startPgPoolMetrics } = require('./utils/metrics');
const { startCapacitySnapshotHeartbeat } = require('./utils/capacitySnapshot');

const PORT = process.env.PORT || 3000;
let server;
let shuttingDown = false;

function startupMaxWaitMs() {
  const raw = process.env.STARTUP_DEPENDENCY_MAX_WAIT_MS;
  const parsed = parseInt(raw || '', 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 60_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry DB + Redis probes so a brief PgBouncer gap (e.g. restart) does not
 * exit(1) and take every chatapp@ instance out of nginx's upstream set.
 */
async function waitForDependencies() {
  const deadline = Date.now() + startupMaxWaitMs();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      await dbQuery('SELECT 1');
      logger.info({ attempt, pool: poolStats() }, 'Postgres connected');
      break;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      const wait = Math.min(5000, 250 * Math.pow(2, Math.min(attempt, 4)));
      logger.warn(
        { err, attempt, retryInMs: wait, pool: poolStats() },
        'Postgres not ready at startup; retrying',
      );
      await sleep(wait);
    }
  }

  attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await redis.ping();
      logger.info({ attempt }, 'Redis connected');
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      const wait = Math.min(5000, 250 * Math.pow(2, Math.min(attempt, 4)));
      logger.warn({ err, attempt, retryInMs: wait }, 'Redis not ready at startup; retrying');
      await sleep(wait);
    }
  }
}

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
    // Close WebSocket connections first so clients reconnect to the new instance
    // rather than being hard-killed by the 10 s SIGKILL timer.  ws.shutdown()
    // sends close frames to all connected clients and waits for wss.close().
    await wsServer.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }

  await Promise.allSettled([
    pool.end(),
    redis.closeRedisConnections(),
  ]);

  clearTimeout(forceExitTimer);
  process.exit(err ? 1 : 0);
}

async function start() {
  await waitForDependencies();

  startPgPoolMetrics(pool);
  startCapacitySnapshotHeartbeat();

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
    // are per-request failures, not server-fatal events — log with pool stats and continue.
    if (
      err.message?.includes('timeout exceeded when trying to connect') ||
      err.message?.includes('Connection terminated') ||
      err.message?.includes('connection timeout') ||
      (err as any).code === 'POOL_CIRCUIT_OPEN'
    ) {
      logger.error({ err, pool: poolStats() }, 'pg-pool transient error (unhandled); request failed without response');
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
