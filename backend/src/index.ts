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
const { pool, readPool, query: dbQuery, poolStats } = require('./db/pool');
const { startMessageIngestConsumerIfEnabled, stopMessageIngestConsumer } = require('./messages/messageIngestLog');
const { startChannelLastMessageFlushInterval } = require('./messages/repointLastMessage');
const redis    = require('./db/redis');
const { startPgPoolMetrics } = require('./utils/metrics');
const { startCapacitySnapshotHeartbeat } = require('./utils/capacitySnapshot');

const PORT = process.env.PORT || 3000;
let server;
let shuttingDown = false;

function isTransientRuntimeError(err) {
  const message = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '');
  return (
    code === 'POOL_CIRCUIT_OPEN' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === '57014' || // query_canceled / statement_timeout
    message.includes('connection terminated unexpectedly') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('connection timeout') ||
    message.includes('canceling statement due to statement timeout') ||
    message.includes('server busy, please retry')
  );
}

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

  stopMessageIngestConsumer();
  await Promise.allSettled([
    pool.end(),
    readPool ? readPool.end() : Promise.resolve(),
    redis.closeRedisConnections(),
  ]);

  clearTimeout(forceExitTimer);
  process.exit(err ? 1 : 0);
}

async function start() {
  await waitForDependencies();
  await wsServer.ready();

  startPgPoolMetrics(pool);
  startCapacitySnapshotHeartbeat();
  startChannelLastMessageFlushInterval();

  server = http.createServer(app);

  // keepAliveTimeout must be > nginx keepalive_timeout (75s) to prevent EOF
  // race where nginx reuses a connection Node already closed.
  server.keepAliveTimeout = 90_000;
  server.headersTimeout   = 95_000;

  // Attach WebSocket upgrade handler to the same HTTP server
  server.on('upgrade', wsServer.handleUpgrade);

  server.listen({ port: PORT, backlog: 4096 }, () => {
    logger.info({ port: PORT }, 'ChatApp API listening');
    startMessageIngestConsumerIfEnabled();
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // Transient DB/network faults are request-scoped under load; keep the process alive.
    if (isTransientRuntimeError(err)) {
      logger.error({ err, pool: poolStats() }, 'Transient runtime rejection; continuing');
      return;
    }
    shutdown('unhandledRejection', err);
  });
  process.on('uncaughtException', (err) => {
    // Some pg/ioredis socket errors can bubble here from event emitters.
    if (isTransientRuntimeError(err)) {
      logger.error({ err, pool: poolStats() }, 'Transient runtime exception; continuing');
      return;
    }
    shutdown('uncaughtException', err);
  });
}

start().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
