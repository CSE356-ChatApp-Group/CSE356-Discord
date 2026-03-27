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

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const ids = (req.query.userIds || '').split(',').filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'userIds query param required' });
    const map = await presence.getBulkPresence(ids);
    res.json({ presence: map });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    const { status } = req.body;
    // `offline` is derived from connection aggregation and is not client-settable.
    const allowed = ['online', 'idle', 'away'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    await presence.setPresence(req.user.id, status);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
