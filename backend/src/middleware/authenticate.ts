/**
 * authenticate – Express middleware that verifies the JWT bearer token.
 * Attaches req.user = { id, username, email } on success.
 */

'use strict';

const { authenticateAccessToken } = require('../utils/jwt');
const { isAuthBypassEnabled, getBypassAuthContext } = require('../auth/bypass');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (isAuthBypassEnabled() && !header.startsWith('Bearer ')) {
      const bypass = await getBypassAuthContext();
      req.user = bypass.user;
      req.token = bypass.token;
      return next();
    }

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = header.slice(7);
    const payload = await authenticateAccessToken(token);

    req.user  = payload;
    req.token = token;
    next();
  } catch (err) {
    if (err?.code === 'TOKEN_REVOKED') {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireRole – factory that returns a middleware enforcing a minimum
 * community role. Must be used after authenticate + loadMembership.
 */
function requireRole(minRole) {
  const RANK = { member: 1, moderator: 2, admin: 3, owner: 4 };
  return (req, res, next) => {
    const role = req.membership?.role;
    if (!role || (RANK[role] || 0) < RANK[minRole]) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
