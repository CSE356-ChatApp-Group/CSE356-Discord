/**
 * Presence routes
 *
 * GET  /api/v1/presence?userIds=id1,id2,...   – bulk status lookup
 * PUT  /api/v1/presence                       – set own status
 */

'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const presence = require('./service');
const { createUserIpTokenLimiter } = require('../middleware/inMemoryApiLimiter');

const PRESENCE_MAX_IDS = 100;

const presenceLimiter = createUserIpTokenLimiter({
  name: 'presence',
  userPerSecond: 10,
  ipPerSecond: 30,
  userBurst: 20,
  ipBurst: 60,
  userScopeLabel: 'presence_inmem_user',
  ipScopeLabel: 'presence_inmem_ip',
});

const router = express.Router();
router.use(authenticate);
router.use(presenceLimiter);

router.get('/', async (req, res, next) => {
  try {
    const ids = (req.query.userIds || '').split(',').filter(Boolean).slice(0, PRESENCE_MAX_IDS);
    if (!ids.length) return res.status(400).json({ error: 'userIds query param required' });
    const details = await presence.getBulkPresenceDetails(ids) as Record<string, { status: string; awayMessage: string | null }>;
    const map = Object.fromEntries(Object.entries(details).map(([id, d]) => [id, d.status]));
    const awayMessages = Object.fromEntries(Object.entries(details)
      .filter(([, d]) => d?.awayMessage)
      .map(([id, d]) => [id, d.awayMessage]));
    res.json({ presence: map, awayMessages });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    const { status, awayMessage } = req.body || {};
    // `offline` is derived from connection aggregation and is not client-settable.
    const allowed = ['online', 'idle', 'away'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    if (awayMessage !== undefined && typeof awayMessage !== 'string' && awayMessage !== null) {
      return res.status(400).json({ error: 'awayMessage must be a string or null' });
    }
    await presence.syncConnectionStatuses(req.user.id, status);
    await presence.setPresence(req.user.id, status, status === 'away' ? awayMessage : null);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
