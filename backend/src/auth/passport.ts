/**
 * Passport strategy registration.
 * Imported once at app start (side-effect module).
 *
 * Strategies:
 *   local    – username/password with bcrypt
 *   google   – OAuth 2.0 via Google
 *   github   – OAuth 2.0 via GitHub
 *
 * OIDC (generic) can be added by following the same pattern as Google
 * using openid-client wrapped in passport-openidconnect.
 */

'use strict';

const passport         = require('passport');
const LocalStrategy    = require('passport-local').Strategy;
const GoogleStrategy   = require('passport-google-oauth20').Strategy;
const GitHubStrategy   = require('passport-github2').Strategy;
const { Issuer, Strategy: OpenIDStrategy } = require('openid-client');
const bcrypt           = require('bcrypt');
const { pool }         = require('../db/pool');
const { signOAuthPending, verifyOAuthLinkIntent } = require('./oauthTokens');

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
async function processOAuthLogin(provider, profileId, email, displayName, stateToken, done) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Existing linked provider login: return mapped user.
    let { rows } = await client.query(
      'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
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

      const owner = await client.query('SELECT * FROM users WHERE id = $1 AND is_active = TRUE', [linkUserId]);
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
    await client.query('ROLLBACK');

    // If provider account just got linked by a concurrent request, recover by
    // loading the mapped user and continue login.
    if (err?.code === '23505') {
      try {
        const linked = await client.query(
          'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
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
    client.release();
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

// ── Course OIDC (OpenID Connect Discovery) ───────────────────────────────────
const COURSE_DISCOVERY_URL = process.env.COURSE_OIDC_DISCOVERY_URL
  || 'https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth/.well-known/openid-configuration';
const COURSE_CLIENT_ID = process.env.COURSE_OIDC_CLIENT_ID || 'web-service';
const COURSE_CLIENT_SECRET = process.env.COURSE_OIDC_CLIENT_SECRET || 'web-service-secret';

if (COURSE_CLIENT_ID && COURSE_CLIENT_SECRET) {
  Issuer.discover(COURSE_DISCOVERY_URL)
    .then((issuer) => {
      const callbackURL = process.env.COURSE_OIDC_CALLBACK_URL || '/api/v1/auth/course/callback';
      const client = new issuer.Client({
        client_id: COURSE_CLIENT_ID,
        client_secret: COURSE_CLIENT_SECRET,
        redirect_uris: [callbackURL],
        response_types: ['code'],
      });

      passport.use('course', new OpenIDStrategy(
        {
          client,
          passReqToCallback: true,
          params: {
            scope: 'openid profile email',
          },
        },
        async (req, tokenSet, userinfo, done) => {
          const sub = userinfo?.sub || tokenSet?.claims?.()?.sub;
          const email = userinfo?.email || tokenSet?.claims?.()?.email || null;
          const displayName = userinfo?.name || userinfo?.preferred_username || email || 'OIDC User';
          if (!sub) return done(null, false, { message: 'OIDC subject missing' });
          await processOAuthLogin('course', sub, email, displayName, req.query?.state, done);
        }
      ));
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to initialize course OIDC strategy:', err?.message || err);
    });
}
