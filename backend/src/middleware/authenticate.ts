/**
 * authenticate – Express middleware that verifies the JWT bearer token.
 * Attaches req.user = { id, username, email } on success.
 */


const { authenticateAccessToken } = require('../utils/jwt');
const { isAuthBypassEnabled, getBypassAuthContext } = require('../auth/bypass');
const { tracer } = require('../utils/tracer');
const { SpanStatusCode } = require('@opentelemetry/api');

async function authenticate(req, res, next) {
  await tracer.startActiveSpan('middleware.authenticate', async (span) => {
    try {
      const header = req.headers.authorization || '';
      if (isAuthBypassEnabled() && !header.startsWith('Bearer ')) {
        const bypass = await getBypassAuthContext();
        req.user = bypass.user;
        req.token = bypass.token;
        span.end();
        return next();
      }

      if (!header.startsWith('Bearer ')) {
        span.end();
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
      }

      const token = header.slice(7);
      const payload = await authenticateAccessToken(token);

      req.user  = payload;
      req.token = token;
      span.end();
      next();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || 'Authentication failed' });
      span.recordException(err);
      span.end();
      if (err?.code === 'TOKEN_REVOKED') {
        return res.status(401).json({ error: 'Token has been revoked' });
      }
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
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
