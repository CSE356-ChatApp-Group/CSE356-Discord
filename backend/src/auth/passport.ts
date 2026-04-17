/**
 * Passport strategy registration.
 * Imported once at app start (side-effect module).
 *
 * Strategies:
 *   local    – username/password with bcrypt
 *   google   – OAuth 2.0 via Google
 *   github   – OAuth 2.0 via GitHub
 *
 * Course OIDC uses the discovery-based /auth/course routes in router.ts (not Passport).
 */

'use strict';

const passport         = require('passport');
const LocalStrategy    = require('passport-local').Strategy;
const GoogleStrategy   = require('passport-google-oauth20').Strategy;
const GitHubStrategy   = require('passport-github2').Strategy;
const { query, getClient } = require('../db/pool');
const { comparePassword, hashPassword, getBcryptRounds, getRoundsFromHash } = require('./passwords');
const { signOAuthPending, verifyOAuthLinkIntent } = require('./oauthTokens');
const AUTH_USER_SELECT = 'id, username, email, display_name, avatar_url, updated_at';

// ── Local ──────────────────────────────────────────────────────────────────────
// The 'email' field also accepts a plain username so that accounts registered
// without an email address can still log in.
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (emailOrUsername, password, done) => {
    try {
      const { rows } = await query(
        `SELECT id, username, email, display_name, avatar_url, updated_at, password_hash
         FROM users
         WHERE (email = $1 OR username = $1) AND is_active = TRUE`,
        [emailOrUsername]
      );
      const user = rows[0];
      if (!user || !user.password_hash) {
        return done(null, false, { message: 'Invalid credentials' });
      }
      const match = await comparePassword(password, user.password_hash, 'login_compare');
      if (!match) return done(null, false, { message: 'Invalid credentials' });

      // Transparent rehash: if the stored cost factor differs from the current
      // target (e.g. legacy higher-cost hashes after lowering BCRYPT_ROUNDS),
      // rewrite the hash on successful login. Fire-and-forget — failure here
      // must never block or fail the login response.
      const storedRounds = getRoundsFromHash(user.password_hash);
      if (storedRounds !== null && storedRounds > getBcryptRounds()) {
        hashPassword(password, 'rehash')
          .then((newHash) => query(
            'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
            [newHash, user.id]
          ))
          .catch(() => {});
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// ── OAuth helper ───────────────────────────────────────────────────────────────
async function processOAuthLogin(provider, profileId, email, displayName, stateToken, done) {
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');

    // Existing linked provider login: return mapped user.
    let { rows } = await client.query(
      `SELECT u.${AUTH_USER_SELECT.split(', ').join(', u.')}
         FROM users u
         JOIN oauth_accounts oa ON oa.user_id = u.id
        WHERE oa.provider=$1 AND oa.provider_id=$2`,
      [provider, profileId]
    );

    if (rows.length) {
      await client.query('COMMIT');
      return done(null, rows[0]);
    }

    // Link intent from authenticated account settings flow.
    if (stateToken) {
      let linkPayload;
      try {
        linkPayload = verifyOAuthLinkIntent(stateToken);
      } catch {
        await client.query('ROLLBACK');
        return done(null, false, { message: 'Invalid link intent token' });
      }

      const linkUserId = linkPayload?.userId;
      if (!linkUserId) {
        await client.query('ROLLBACK');
        return done(null, false, { message: 'Invalid link intent payload' });
      }

      const owner = await client.query(
        `SELECT ${AUTH_USER_SELECT}
           FROM users
          WHERE id = $1 AND is_active = TRUE`,
        [linkUserId],
      );
      if (!owner.rows.length) {
        await client.query('ROLLBACK');
        return done(null, false, { message: 'Link target account not found' });
      }

      await client.query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
        [owner.rows[0].id, provider, profileId, email || null]
      );

      await client.query('COMMIT');
      return done(null, owner.rows[0]);
    }

    // No account mapping exists yet. Return a short-lived pending token and
    // let the user choose create-vs-connect in the frontend callback flow.
    const pendingToken = signOAuthPending({
      provider,
      providerId: profileId,
      email: email || null,
      displayName: displayName || null,
    });

    await client.query('COMMIT');
    return done(null, {
      oauthPendingToken: pendingToken,
      provider,
      email: email || null,
      displayName: displayName || null,
    });
  } catch (err) {
    await client?.query('ROLLBACK');

    // If provider account just got linked by a concurrent request, recover by
    // loading the mapped user and continue login.
    if (err?.code === '23505') {
      try {
        const linked = await client.query(
          `SELECT u.${AUTH_USER_SELECT.split(', ').join(', u.')}
             FROM users u
             JOIN oauth_accounts oa ON oa.user_id = u.id
            WHERE oa.provider=$1 AND oa.provider_id=$2`,
          [provider, profileId]
        );
        if (linked.rows.length) {
          await client.query('COMMIT');
          return done(null, linked.rows[0]);
        }
      } catch {
        // Fall through to error return.
      }
    }
    return done(err);
  } finally {
    client?.release();
  }
}

// ── Google ─────────────────────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/api/v1/auth/google/callback',
    passReqToCallback: true,
  }, async (req, accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    await processOAuthLogin('google', profile.id, email, profile.displayName, req.query?.state, done);
  }));
}

// ── GitHub ─────────────────────────────────────────────────────────────────────
if (process.env.GITHUB_CLIENT_ID) {
  passport.use(new GitHubStrategy({
    clientID:     process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL:  process.env.GITHUB_CALLBACK_URL || '/api/v1/auth/github/callback',
    scope: ['user:email'],
    passReqToCallback: true,
  }, async (req, accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    await processOAuthLogin('github', profile.id, email, profile.displayName, req.query?.state, done);
  }));
}
