'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../db/redis');
const {
  clientWebVitalTimingSeconds,
  clientWebVitalClsScore,
  clientRumBatchesTotal,
  apiRateLimitHitsTotal,
} = require('../utils/metrics');

const router = express.Router();

const rumPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: { ip?: string }) => `rum:${req.ip || 'unknown'}`,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...args),
    prefix: 'rl:rum:',
  }),
  message: { error: 'Too many RUM reports. Please try again later.' },
  handler: (_req: any, res: any, _next: any, options: { statusCode: number; message?: unknown }) => {
    apiRateLimitHitsTotal.inc({ scope: 'rum' });
    res.status(options.statusCode).json(options.message);
  },
});

function rumLimiterOrPassthrough() {
  if (process.env.DISABLE_RATE_LIMITS === 'true') {
    return (_req: any, _res: any, next: any) => next();
  }
  return rumPostLimiter;
}

const TIMING_NAMES = new Set(['LCP', 'INP', 'FCP', 'TTFB']);

router.post('/rum', rumLimiterOrPassthrough(), express.json({ limit: '16kb' }), (req: any, res: any) => {
  const metrics = req.body?.metrics;
  if (!Array.isArray(metrics)) {
    return res.status(400).json({ error: 'metrics array required' });
  }
  for (const m of metrics) {
    if (!m || typeof m !== 'object') continue;
    const name = String(m.name || '').toUpperCase();
    const value = Number(m.value);
    if (!Number.isFinite(value)) continue;
    if (name === 'CLS') {
      clientWebVitalClsScore.observe({ name: 'CLS' }, Math.min(Math.max(value, 0), 10));
    } else if (TIMING_NAMES.has(name)) {
      clientWebVitalTimingSeconds.observe({ name }, value / 1000);
    }
  }
  clientRumBatchesTotal.inc();
  return res.status(204).end();
});

module.exports = router;
