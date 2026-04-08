'use strict';

const bcrypt = require('bcrypt');
const { authBcryptDurationMs } = require('../utils/metrics');

const BCRYPT_MAX_CONCURRENT = (() => {
  const n = Number.parseInt(process.env.BCRYPT_MAX_CONCURRENT || '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
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

function enterBcrypt() {
  if (bcryptActive < BCRYPT_MAX_CONCURRENT) {
    bcryptActive += 1;
    return Promise.resolve();
  }
  if (bcryptWaiters.length >= BCRYPT_MAX_WAITERS) {
    const err: any = new Error('bcrypt queue saturated');
    err.code = 'BCRYPT_QUEUE_SATURATED';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = bcryptWaiters.indexOf(onReady);
      if (idx >= 0) bcryptWaiters.splice(idx, 1);
      const err: any = new Error('bcrypt queue wait timeout');
      err.code = 'BCRYPT_QUEUE_TIMEOUT';
      reject(err);
    }, BCRYPT_QUEUE_WAIT_TIMEOUT_MS);
    const onReady = () => {
      clearTimeout(timeout);
      bcryptActive += 1;
      resolve(undefined);
    };
    bcryptWaiters.push(onReady);
  });
}

function leaveBcrypt() {
  bcryptActive -= 1;
  const next = bcryptWaiters.shift();
  if (next) next();
}

async function withBcryptConcurrency(fn) {
  await enterBcrypt();
  try {
    return await fn();
  } finally {
    leaveBcrypt();
  }
}

// Default to 6 rounds for adequate security while staying responsive on a
// 2-vCPU staging VM (10 rounds = ~500ms/op; 8 rounds = ~125ms/op; 6 rounds ~30ms/op).
// Override with BCRYPT_ROUNDS in production for stricter hashing.
const DEFAULT_BCRYPT_ROUNDS = 6;
const MIN_BCRYPT_ROUNDS = 6;
const MAX_BCRYPT_ROUNDS = 14;

function getBcryptRounds() {
  const configured = Number.parseInt(process.env.BCRYPT_ROUNDS || `${DEFAULT_BCRYPT_ROUNDS}`, 10);
  if (!Number.isFinite(configured)) return DEFAULT_BCRYPT_ROUNDS;
  return Math.min(MAX_BCRYPT_ROUNDS, Math.max(MIN_BCRYPT_ROUNDS, configured));
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
};
