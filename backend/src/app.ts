/**
 * Express application – middleware stack and route mounting.
 * Kept separate from index.js so tests can import without starting a server.
 */

'use strict';

const crypto       = require('crypto');
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
const { register, httpRequestsTotal, httpRequestDurationMs } = require('./utils/metrics');

function isQuietPath(path = '') {
  return path === '/health' || path === '/metrics';
}

function classifyRoute(req) {
  const routePath = Array.isArray(req.route?.path) ? req.route.path[0] : req.route?.path;
  if (routePath) {
    return `${req.baseUrl || ''}${routePath}`.replace(/\/+/g, '/');
  }

  const rawPath = (req.originalUrl || req.url || '').split('?')[0];
  if (!rawPath) return 'unknown';
  if (isQuietPath(rawPath)) return rawPath;
  return 'unmatched';
}

// ── Security / Utility middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || crypto.randomUUID();
    res.setHeader('x-request-id', requestId);
    return requestId;
  },
  autoLogging: {
    ignore(req) {
      const path = (req.originalUrl || req.url || '').split('?')[0];
      return process.env.NODE_ENV === 'production' && isQuietPath(path);
    },
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        query: req.query,
        params: req.params,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    const responseTime = Number(res.responseTime || 0);
    if (responseTime >= 1000) return 'warn';
    return process.env.NODE_ENV === 'production' ? 'silent' : 'info';
  },
  customProps(req, res) {
    return {
      requestId: req.id,
      route: classifyRoute(req),
      statusCode: res.statusCode,
      userId: req.user?.id,
    };
  },
  customSuccessMessage(req, res) {
    return Number(res.responseTime || 0) >= 1000 ? 'Slow request completed' : 'Request completed';
  },
  customErrorMessage(req, res, err) {
    return err ? 'Request errored' : 'Request completed with client error';
  },
}));
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const labels = {
      method: req.method,
      route: classifyRoute(req),
      status_class: `${Math.floor(res.statusCode / 100)}xx`,
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationMs.observe(labels, durationMs);
  });
  next();
});
app.use(passport.initialize());

// ── Prometheus metrics (no auth required) ─────────────────────────────────────
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

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    requestId: req.id,
  });
});

// ── Global error handler ───────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const requestId = req.id;
  logger.error({ err, url: req.url, requestId, status }, 'Unhandled error');
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (err.message || 'Request failed'),
    requestId,
    ...(err.errors && { errors: err.errors }),
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = app;
