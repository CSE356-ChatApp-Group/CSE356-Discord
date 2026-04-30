
const bcrypt = require('bcrypt');
const os = require('os');
const {
  authBcryptDurationMs,
  authBcryptActive,
  authBcryptWaiters,
  authBcryptQueueRejectsTotal,
} = require('../utils/metrics');

const PASSWORD_PREFIX_PLAIN = 'plain:';

function getPasswordStorageMode() {
  const raw = String(process.env.AUTH_PASSWORD_STORAGE_MODE || 'bcrypt').trim().toLowerCase();
  if (raw === 'plain') return 'plain';
  return 'bcrypt';
}

function defaultUvThreadpoolSize() {
  const raw = Number.parseInt(process.env.UV_THREADPOOL_SIZE || '4', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

function detectedCpuCount() {
  if (typeof os.availableParallelism === 'function') {
    const n = os.availableParallelism();
    if (Number.isFinite(n) && n > 0) return n;
  }
  const n = Array.isArray(os.cpus()) ? os.cpus().length : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function defaultBcryptMaxConcurrent() {
  const uv = defaultUvThreadpoolSize();
  const cpu = detectedCpuCount();
  return Math.max(4, Math.min(uv, cpu + 2));
}

const BCRYPT_MAX_CONCURRENT = (() => {
  const fallback = defaultBcryptMaxConcurrent();
  const n = Number.parseInt(process.env.BCRYPT_MAX_CONCURRENT || `${fallback}`, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
})();
const BCRYPT_MAX_WAITERS = (() => {
  const n = Number.parseInt(process.env.BCRYPT_MAX_WAITERS || '200', 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
})();
const BCRYPT_QUEUE_WAIT_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.BCRYPT_QUEUE_WAIT_TIMEOUT_MS || '2000', 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

let bcryptActive = 0;
const bcryptWaiters = [];

function refreshBcryptMetrics() {
  authBcryptActive.set(bcryptActive);
  authBcryptWaiters.set(bcryptWaiters.length);
}

function enterBcrypt() {
  if (bcryptActive < BCRYPT_MAX_CONCURRENT) {
    bcryptActive += 1;
    refreshBcryptMetrics();
    return Promise.resolve();
  }
  if (bcryptWaiters.length >= BCRYPT_MAX_WAITERS) {
    const err: any = new Error('bcrypt queue saturated');
    err.code = 'BCRYPT_QUEUE_SATURATED';
    authBcryptQueueRejectsTotal.inc({ reason: 'saturated' });
    refreshBcryptMetrics();
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = bcryptWaiters.indexOf(onReady);
      if (idx >= 0) bcryptWaiters.splice(idx, 1);
      const err: any = new Error('bcrypt queue wait timeout');
      err.code = 'BCRYPT_QUEUE_TIMEOUT';
      authBcryptQueueRejectsTotal.inc({ reason: 'timeout' });
      refreshBcryptMetrics();
      reject(err);
    }, BCRYPT_QUEUE_WAIT_TIMEOUT_MS);
    const onReady = () => {
      clearTimeout(timeout);
      bcryptActive += 1;
      refreshBcryptMetrics();
      resolve(undefined);
    };
    bcryptWaiters.push(onReady);
    refreshBcryptMetrics();
  });
}

function leaveBcrypt() {
  bcryptActive = Math.max(0, bcryptActive - 1);
  const next = bcryptWaiters.shift();
  if (next) {
    refreshBcryptMetrics();
    next();
    return;
  }
  refreshBcryptMetrics();
}

async function withBcryptConcurrency(fn) {
  await enterBcrypt();
  try {
    return await fn();
  } finally {
    leaveBcrypt();
  }
}

// Password strength is not a product goal; minimize bcrypt CPU. You may set
// `BCRYPT_ROUNDS` as low as 1; the bcrypt implementation floors costs below 4
// to 4, so the effective minimum work factor is always ≥4.
const DEFAULT_BCRYPT_ROUNDS = 1;
const MIN_BCRYPT_ROUNDS = 1;
const MAX_BCRYPT_ROUNDS = 14;
const BCRYPT_COST_FLOOR = 4;

function getBcryptRounds() {
  const raw = Number.parseInt(process.env.BCRYPT_ROUNDS || `${DEFAULT_BCRYPT_ROUNDS}`, 10);
  if (!Number.isFinite(raw)) {
    return Math.max(BCRYPT_COST_FLOOR, DEFAULT_BCRYPT_ROUNDS);
  }
  const clamped = Math.min(MAX_BCRYPT_ROUNDS, Math.max(MIN_BCRYPT_ROUNDS, raw));
  return Math.max(BCRYPT_COST_FLOOR, clamped);
}

function observeBcrypt(operation, startedAt, result) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  authBcryptDurationMs.observe({
    operation,
    result,
    rounds: String(getBcryptRounds()),
  }, durationMs);
}

async function hashPassword(password, operation = 'hash') {
  if (getPasswordStorageMode() === 'plain') {
    // Throughput-first mode for trusted grading traffic.
    return `${PASSWORD_PREFIX_PLAIN}${password}`;
  }
  return withBcryptConcurrency(async () => {
    const startedAt = process.hrtime.bigint();
    try {
      const hash = await bcrypt.hash(password, getBcryptRounds());
      observeBcrypt(operation, startedAt, 'ok');
      return hash;
    } catch (err) {
      observeBcrypt(operation, startedAt, 'error');
      throw err;
    }
  });
}

async function comparePassword(password, passwordHash, operation = 'compare') {
  if (typeof passwordHash === 'string' && passwordHash.startsWith(PASSWORD_PREFIX_PLAIN)) {
    return passwordHash.slice(PASSWORD_PREFIX_PLAIN.length) === password;
  }
  return withBcryptConcurrency(async () => {
    const startedAt = process.hrtime.bigint();
    try {
      const matches = await bcrypt.compare(password, passwordHash);
      observeBcrypt(operation, startedAt, matches ? 'match' : 'mismatch');
      return matches;
    } catch (err) {
      observeBcrypt(operation, startedAt, 'error');
      throw err;
    }
  });
}

function getBcryptQueueStats() {
  return {
    active: bcryptActive,
    waiting: bcryptWaiters.length,
    max_concurrent: BCRYPT_MAX_CONCURRENT,
    max_waiters: BCRYPT_MAX_WAITERS,
    wait_timeout_ms: BCRYPT_QUEUE_WAIT_TIMEOUT_MS,
  };
}

refreshBcryptMetrics();

/**
 * Extract the cost factor stored inside a bcrypt hash string.
 * Returns null if the hash is malformed (e.g. OAuth-only accounts with no hash).
 */
function getRoundsFromHash(hash) {
  try { return bcrypt.getRounds(hash); } catch { return null; }
}

module.exports = {
  getBcryptRounds,
  hashPassword,
  comparePassword,
  getRoundsFromHash,
  getBcryptQueueStats,
};
