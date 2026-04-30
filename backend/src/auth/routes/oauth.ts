/**
 * Auth routes — oauth
 */
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const { query, getClient } = require('../../db/pool');
const { authenticate } = require('../../middleware/authenticate');
const { hashPassword, comparePassword } = require('../passwords');
const { verifyOAuthPending } = require('../oauthTokens');
const S = require('../shared');

module.exports = function register(router) {
router.post('/oauth/complete-create',
  S.registerGlobalIpLimiter,
  S.registerLimiter,
  body('pendingToken').isString().custom((value) => value.trim().length > 0),
  body('username').optional().isString(),
  body('displayName').optional().isString(),
  body('password').optional().isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let pending;
    try {
      pending = verifyOAuthPending(req.body.pendingToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired OAuth continuation token' });
    }

    const email = pending.email || req.body.email;
    if (!email) {
      return res.status(400).json({ error: 'Email is required to create an account from OAuth sign-in' });
    }

    const generatedUsernameBase = (email.split('@')[0] || `${pending.provider}_user`).trim()
      || `${pending.provider}user`;

    const preferredUsername = typeof pending.preferredUsername === 'string' && pending.preferredUsername.trim()
      ? pending.preferredUsername.trim()
      : typeof req.body.username === 'string' && req.body.username.trim()
        ? req.body.username.trim()
        : null;
    const username = preferredUsername || `${generatedUsernameBase}-${Date.now().toString().slice(-4)}`;
    const displayName = req.body.displayName || pending.displayName || username;

    let client;
    try {
      client = await getClient();
      await client.query('BEGIN');

      const existingProvider = await client.query(
        `SELECT u.${S.AUTH_USER_SELECT.split(', ').join(', u.')}
           FROM users u
           JOIN oauth_accounts oa ON oa.user_id = u.id
          WHERE oa.provider=$1 AND oa.provider_id=$2`,
        [pending.provider, pending.providerId]
      );
      if (existingProvider.rows.length) {
        await client.query('COMMIT');
        return res.json(S.issueTokens(res, existingProvider.rows[0]));
      }

      const emailTaken = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (emailTaken.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already exists. Use connect-existing flow.' });
      }

      const passwordHash = req.body.password ? await hashPassword(req.body.password, 'oauth_create_hash') : null;
      const created = await client.query(
        `INSERT INTO users (email, username, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING ${S.AUTH_USER_SELECT}`,
        [email, username, displayName, passwordHash]
      );

      const user = created.rows[0];
      await client.query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
        [user.id, pending.provider, pending.providerId, email]
      );

      await client.query('COMMIT');
      return res.json(S.issueTokens(res, user));
    } catch (err) {
      await client?.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Could not complete account creation due to conflicting account data' });
      }
      return next(err);
    } finally {
      client?.release();
    }
  }
);

router.post('/oauth/complete-connect',
  S.passwordConnectLimiter,
  body('pendingToken').isString().custom((value) => value.trim().length > 0),
  body('email').isString().custom((value) => value.trim().length > 0),
  body('password').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let pending;
    try {
      pending = verifyOAuthPending(req.body.pendingToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired OAuth continuation token' });
    }

    let client;
    try {
      client = await getClient();
      await client.query('BEGIN');

      const existingProvider = await client.query(
        `SELECT u.${S.AUTH_USER_SELECT.split(', ').join(', u.')}
           FROM users u
           JOIN oauth_accounts oa ON oa.user_id = u.id
          WHERE oa.provider=$1 AND oa.provider_id=$2`,
        [pending.provider, pending.providerId]
      );
      if (existingProvider.rows.length) {
        await client.query('COMMIT');
        return res.json(S.issueTokens(res, existingProvider.rows[0]));
      }

      const account = await client.query(
        `SELECT ${S.AUTH_USER_SELECT_WITH_PASSWORD}
           FROM users
          WHERE email=$1 AND is_active=TRUE`,
        [req.body.email],
      );
      if (!account.rows.length) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid credentials for existing account' });
      }

      const user = account.rows[0];
      if (!user.password_hash) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Existing account has no password; set one first before connecting by credentials' });
      }

      const ok = await comparePassword(req.body.password, user.password_hash, 'oauth_connect_compare');
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid credentials for existing account' });
      }

      await client.query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
        [user.id, pending.provider, pending.providerId, pending.email || req.body.email]
      );

      await client.query('COMMIT');
      return res.json(S.issueTokens(res, user));
    } catch (err) {
      await client?.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'OAuth account is already linked to another user' });
      }
      return next(err);
    } finally {
      client?.release();
    }
  }
);

router.post('/oauth/link-intent', authenticate,
  body('provider').isIn(['google', 'github', 'course']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const provider = req.body.provider;
    const linkToken = S.signOAuthLinkIntent({
      userId: req.user.id,
      provider,
      purpose: 'oauth-link',
    });

    const authUrl = `/api/v1/auth/${provider}?linkToken=${encodeURIComponent(linkToken)}`;
    return res.json({ provider, authUrl });
  }
);

router.get('/oauth/linked', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT provider FROM oauth_accounts WHERE user_id = $1 ORDER BY provider ASC',
      [req.user.id]
    );
    const passwordRow = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    return res.json({
      providers: rows.map(r => r.provider),
      hasPassword: Boolean(passwordRow.rows[0]?.password_hash),
    });
  } catch (err) {
    return next(err);
  }
});
};
