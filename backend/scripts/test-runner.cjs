#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');

const PG_CONTAINER = 'chatapp-test-postgres';
const REDIS_CONTAINER = 'chatapp-test-redis';
const PG_PORT = process.env.TEST_PG_PORT || '55432';
const REDIS_PORT = process.env.TEST_REDIS_PORT || '56379';
const jestArgs = process.argv.slice(2);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function runQuiet(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: 'ignore',
    ...options,
  });
}

function assertDockerAvailable() {
  const check = runQuiet('docker', ['--version']);
  if (check.status !== 0) {
    console.error('Docker is required for local tests when DATABASE_URL is not set.');
    process.exit(1);
  }
}

function removeContainer(name) {
  runQuiet('docker', ['rm', '-f', name]);
}

function waitFor(command, args, timeoutMs, intervalMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probe = runQuiet(command, args);
    if (probe.status === 0) return;

    const sleep = spawnSync('sleep', [String(intervalMs / 1000)], { stdio: 'ignore' });
    if (sleep.error) {
      break;
    }
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function startContainers() {
  removeContainer(PG_CONTAINER);
  removeContainer(REDIS_CONTAINER);

  let code = run('docker', [
    'run', '-d',
    '--name', PG_CONTAINER,
    '-e', 'POSTGRES_DB=chatapp_test',
    '-e', 'POSTGRES_USER=chatapp',
    '-e', 'POSTGRES_PASSWORD=test',
    '-p', `${PG_PORT}:5432`,
    'postgres:16-alpine',
  ]);
  if (code !== 0) process.exit(code);

  code = run('docker', [
    'run', '-d',
    '--name', REDIS_CONTAINER,
    '-p', `${REDIS_PORT}:6379`,
    'redis:7-alpine',
  ]);
  if (code !== 0) process.exit(code);

  waitFor('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', 'chatapp', '-d', 'chatapp_test'], 45_000, 1_000, 'Postgres');
  waitFor('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'ping'], 20_000, 1_000, 'Redis');
}

function runLocalTests() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL || `postgres://chatapp:test@127.0.0.1:${PG_PORT}/chatapp_test`,
    REDIS_URL: process.env.REDIS_URL || `redis://127.0.0.1:${REDIS_PORT}`,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'test-secret',
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'test-refresh',
    DISABLE_SEARCH_INIT: process.env.DISABLE_SEARCH_INIT || 'true',
  };

  let code = run('npm', ['run', 'migrate'], { env });
  if (code !== 0) return code;

  const testArgs = jestArgs.length ? ['run', 'test:raw', '--', ...jestArgs] : ['run', 'test:raw'];
  code = run('npm', testArgs, { env });
  return code;
}

function runCiStyleTests() {
  const env = {
    ...process.env,
    DISABLE_SEARCH_INIT: process.env.DISABLE_SEARCH_INIT || 'true',
  };
  const testArgs = jestArgs.length ? ['run', 'test:raw', '--', ...jestArgs] : ['run', 'test:raw'];
  return run('npm', testArgs, { env });
}

const shouldProvision = !process.env.DATABASE_URL;
let exitCode = 1;

try {
  if (!shouldProvision) {
    exitCode = runCiStyleTests();
    process.exit(exitCode);
  }

  assertDockerAvailable();
  startContainers();
  exitCode = runLocalTests();
} catch (err) {
  console.error(err.message || err);
  exitCode = 1;
} finally {
  if (shouldProvision && process.env.KEEP_TEST_CONTAINERS !== '1') {
    removeContainer(PG_CONTAINER);
    removeContainer(REDIS_CONTAINER);
  }
}

process.exit(exitCode);
