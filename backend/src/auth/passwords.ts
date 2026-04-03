'use strict';

const bcrypt = require('bcrypt');
const { authBcryptDurationMs } = require('../utils/metrics');

const DEFAULT_BCRYPT_ROUNDS = 12;
const MIN_BCRYPT_ROUNDS = 8;
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
  const startedAt = process.hrtime.bigint();
  try {
    const hash = await bcrypt.hash(password, getBcryptRounds());
    observeBcrypt(operation, startedAt, 'ok');
    return hash;
  } catch (err) {
    observeBcrypt(operation, startedAt, 'error');
    throw err;
  }
}

async function comparePassword(password, passwordHash, operation = 'compare') {
  const startedAt = process.hrtime.bigint();
  try {
    const matches = await bcrypt.compare(password, passwordHash);
    observeBcrypt(operation, startedAt, matches ? 'match' : 'mismatch');
    return matches;
  } catch (err) {
    observeBcrypt(operation, startedAt, 'error');
    throw err;
  }
}

module.exports = {
  getBcryptRounds,
  hashPassword,
  comparePassword,
};
