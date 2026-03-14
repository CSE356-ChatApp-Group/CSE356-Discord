/**
 * ChatApp MVP – Entry point
 *
 * Starts the Express HTTP server and attaches the WebSocket upgrade handler
 * on the same port so a single ingress rule covers both REST and WS traffic.
 */

'use strict';

require('dotenv').config();

const http     = require('http');
const app      = require('./app');
const wsServer = require('./websocket/server');
const logger   = require('./utils/logger');
const { pool } = require('./db/pool');
const redis    = require('./db/redis');

const PORT = process.env.PORT || 3000;

async function start() {
  // Verify DB connectivity before accepting traffic
  await pool.query('SELECT 1');
  logger.info('Postgres connected');

  await redis.ping();
  logger.info('Redis connected');

  const server = http.createServer(app);

  // Attach WebSocket upgrade handler to the same HTTP server
  server.on('upgrade', wsServer.handleUpgrade);

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'ChatApp API listening');
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down…');
    server.close(async () => {
      await pool.end();
      await redis.quit();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});
