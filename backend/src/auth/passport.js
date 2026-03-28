/**
 * Passport strategy registration.
 * Imported once at app start (side-effect module).
 *
 * Strategies:
 *   local    – username/password with bcrypt
 *   google   – OAuth 2.0 via Google
 *   github   – OAuth 2.0 via GitHub
 *   oidc     – OpenID Connect (class instructor platform)
 */

'use strict';

const passport         = require('passport');
const LocalStrategy    = require('passport-local').Strategy;
const GoogleStrategy   = require('passport-google-oauth20').Strategy;
const GitHubStrategy   = require('passport-github2').Strategy;
const OpenIDConnectStrategy = require('passport-openidconnect').Strategy;
const bcrypt           = require('bcrypt');
const { pool }         = require('../db/pool');

// ── Local ──────────────────────────────────────────────────────────────────────
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email]
      );
      const user = rows[0];
      if (!user || !user.password_hash) {
        return done(null, false, { message: 'Invalid credentials' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return done(null, false, { message: 'Invalid credentials' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// ── OAuth helper ───────────────────────────────────────────────────────────────
async function handleOAuth(provider, profileId, email, displayName, done) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up existing OAuth account
    let { rows } = await client.query(
      'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
      [provider, profileId]
    );

    if (rows.length) {
      await client.query('COMMIT');
      return done(null, rows[0]);
    }

    // Check if email already registered
    ({ rows } = await client.query('SELECT * FROM users WHERE email=$1', [email]));
    let user = rows[0];

    if (!user) {
      // Create new user
      ({ rows } = await client.query(
        `INSERT INTO users (email, username, display_name)
         VALUES ($1, $2, $3) RETURNING *`,
        [email, email.split('@')[0] + '_' + Date.now(), displayName]
      ));
      user = rows[0];
    }

    await client.query(
      'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
      [user.id, provider, profileId, email]
    );

    await client.query('COMMIT');
    return done(null, user);
  } catch (err) {
    await client.query('ROLLBACK');
    return done(err);
  } finally {
    client.release();
  }
}

// ── Google ─────────────────────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/api/v1/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    await handleOAuth('google', profile.id, email, profile.displayName, done);
  }));
}

// ── GitHub ─────────────────────────────────────────────────────────────────────
if (process.env.GITHUB_CLIENT_ID) {
  passport.use(new GitHubStrategy({
    clientID:     process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL:  process.env.GITHUB_CALLBACK_URL || '/api/v1/auth/github/callback',
    scope: ['user:email'],
  }, async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    await handleOAuth('github', profile.id, email, profile.displayName, done);
  }));
}

// ── OIDC (Class Instructor Platform) ────────────────────────────────────────────
if (process.env.OIDC_CLIENT_ID) {
  passport.use(new OpenIDConnectStrategy({
    issuer: 'https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth',
    authorizationURL: 'https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth/protocol/openid-connect/auth',
    tokenURL: 'https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth/protocol/openid-connect/token',
    userInfoURL: 'https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth/protocol/openid-connect/userinfo',
    clientID: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    callbackURL: process.env.OIDC_CALLBACK_URL || '/api/v1/auth/oidc/callback',
    scope: ['openid', 'profile', 'email'],
  }, async (issuer, profile, done) => {
    // OIDC profile structure is standardized
    const email = profile.emails?.[0]?.value || profile._json?.email;
    const displayName = profile.displayName || profile._json?.name || profile.username;
    await handleOAuth('oidc', profile.id, email, displayName, done);
  }));
}
