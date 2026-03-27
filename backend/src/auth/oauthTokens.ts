'use strict';

const jwt = require('jsonwebtoken');

const PENDING_SECRET = process.env.OAUTH_PENDING_SECRET || process.env.JWT_REFRESH_SECRET || 'change-me-refresh';
const LINK_SECRET = process.env.OAUTH_LINK_SECRET || process.env.JWT_ACCESS_SECRET || 'change-me-access';

function signOAuthPending(payload) {
  return jwt.sign(payload, PENDING_SECRET, { expiresIn: '10m' });
}

function verifyOAuthPending(token) {
  return jwt.verify(token, PENDING_SECRET);
}

function signOAuthLinkIntent(payload) {
  return jwt.sign(payload, LINK_SECRET, { expiresIn: '10m' });
}

function verifyOAuthLinkIntent(token) {
  return jwt.verify(token, LINK_SECRET);
}

module.exports = {
  signOAuthPending,
  verifyOAuthPending,
  signOAuthLinkIntent,
  verifyOAuthLinkIntent,
};
