/**
 * Express application – middleware stack and route mounting.
 * Kept separate from index.js so tests can import without starting a server.
 */

'use strict';

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const pinoHttp     = require('pino-http');
const passport     = require('passport');

const logger = require('./utils/logger');
require('./auth/passport');          // register passport strategies

// ── Route modules ─────────────────────────────────────────────────────────────
const authRouter         = require('./auth/router');
const communitiesRouter  = require('./communities/router');
const channelsRouter     = require('./channels/router');
const conversationsRouter= require('./messages/conversationsRouter');
const messagesRouter     = require('./messages/router');
const presenceRouter     = require('./presence/router');
const searchRouter       = require('./search/router');
const attachmentsRouter  = require('./attachments/router');
const usersRouter        = require('./auth/usersRouter');

const app = express();

// ── Security / Utility middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));
app.use(passport.initialize());

// ── Prometheus metrics (no auth required) ─────────────────────────────────────
const { register } = require('./utils/metrics');
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ── Health check (no auth required) ───────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    // Check DB
    await require('./db/pool').pool.query('SELECT 1');
    // Check Redis
    await require('./db/redis').ping();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    logger.warn({ err }, 'Health check failed');
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// ── API routes ─────────────────────────────────────────────────────────────────
const api = express.Router();
api.use('/auth',          authRouter);
api.use('/users',         usersRouter);
api.use('/communities',   communitiesRouter);
api.use('/channels',      channelsRouter);
api.use('/conversations', conversationsRouter);
api.use('/messages',      messagesRouter);
api.use('/presence',      presenceRouter);
api.use('/search',        searchRouter);
api.use('/attachments',   attachmentsRouter);

app.use('/api/v1', api);

// ── Global error handler ───────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  logger.error({ err, url: req.url }, 'Unhandled error');
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = app;
