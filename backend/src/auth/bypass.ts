
const { query } = require('../db/pool');

const BYPASS_USER = {
  id: process.env.AUTH_BYPASS_USER_ID || '00000000-0000-4000-8000-000000000001',
  email: process.env.AUTH_BYPASS_USER_EMAIL || 'dev@chatapp.local',
  username: process.env.AUTH_BYPASS_USER_USERNAME || 'devuser',
  displayName: process.env.AUTH_BYPASS_USER_DISPLAY_NAME || 'Dev User',
};

let ensuredUserPromise;

function isAuthBypassEnabled() {
  return process.env.AUTH_BYPASS === 'true';
}

async function ensureBypassUser() {
  if (!ensuredUserPromise) {
    ensuredUserPromise = upsertBypassUser().catch((err) => {
      ensuredUserPromise = undefined;
      throw err;
    });
  }

  return ensuredUserPromise;
}

async function upsertBypassUser() {
  const { rows } = await query(
    `INSERT INTO users (id, email, username, display_name, password_hash)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (id)
     DO UPDATE SET
       email = EXCLUDED.email,
       username = EXCLUDED.username,
       display_name = EXCLUDED.display_name,
       is_active = TRUE,
       updated_at = NOW()
     RETURNING id, email, username, display_name`,
    [BYPASS_USER.id, BYPASS_USER.email, BYPASS_USER.username, BYPASS_USER.displayName]
  );

  return rows[0];
}

async function getBypassAuthContext() {
  const user = await ensureBypassUser();
  return {
    token: null,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      authBypass: true,
    },
  };
}

module.exports = {
  isAuthBypassEnabled,
  getBypassAuthContext,
};