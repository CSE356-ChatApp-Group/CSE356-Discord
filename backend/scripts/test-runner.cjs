#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');

const jestArgs = process.argv.slice(2);
const isCiEnvironment = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

/**
 * Fixed names locally; unique per workflow run on GitHub so parallel jobs on the
 * same self-hosted runner do not docker rm -f each other's test DB.
 */
function testContainerSuffix() {
  if (!isCiEnvironment) return '';
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  if (runId) return `-${runId}-${attempt}`;
  return `-${process.pid}`;
}

const PG_CONTAINER = `chatapp-test-postgres${testContainerSuffix()}`;
const REDIS_CONTAINER = `chatapp-test-redis${testContainerSuffix()}`;

function hasArg(args, flag) {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function getEffectiveJestArgs() {
  const effectiveArgs = [...jestArgs];

  if (isCiEnvironment && !hasArg(effectiveArgs, '--runInBand')) {
    effectiveArgs.unshift('--runInBand');
  }

  if (isCiEnvironment && !hasArg(effectiveArgs, '--verbose')) {
    effectiveArgs.push('--verbose');
  }

  return effectiveArgs;
}

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

  const err = new Error(`Timed out waiting for ${label}`);
  err.label = label;
  throw err;
}

function dockerLogsTail(container, lines = 120) {
  spawnSync('docker', ['logs', '--tail', String(lines), container], { stdio: 'inherit' });
}

function dockerInspectState(container) {
  spawnSync('docker', ['inspect', '-f', '{{json .State}}', container], { stdio: 'inherit' });
}

/**
 * Host port Docker bound for an exposed container port (works with `docker run -P`).
 */
function getDockerPublishPort(container, internalPort) {
  const r = spawnSync('docker', ['port', container, `${internalPort}/tcp`], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `docker port failed for ${container} ${internalPort}: ${r.stderr || r.stdout || r.error}`,
    );
  }
  const first = r.stdout.trim().split('\n')[0];
  const m = first.match(/:(\d+)\s*$/);
  if (!m) throw new Error(`Could not parse host port from: ${JSON.stringify(first)}`);
  return m[1];
}

/**
 * @returns {{ pgPort: string, redisPort: string }}
 */
function startContainers() {
  removeContainer(PG_CONTAINER);
  removeContainer(REDIS_CONTAINER);

  const envPg = process.env.TEST_PG_PORT;
  const envRedis = process.env.TEST_REDIS_PORT;
  // GitHub-hosted runners sometimes have fixed ports (55432/56379) still bound from a
  // leaked process or overlapping job — publish random ports via -P and read mappings.
  const useDynamicHostPorts = isCiEnvironment && !envPg && !envRedis;

  const pgRunArgs = useDynamicHostPorts
    ? [
      'run', '-d',
      '--name', PG_CONTAINER,
      '-P',
      '-e', 'POSTGRES_DB=chatapp_test',
      '-e', 'POSTGRES_USER=chatapp',
      '-e', 'POSTGRES_PASSWORD=test',
      'postgres:16-alpine',
    ]
    : [
      'run', '-d',
      '--name', PG_CONTAINER,
      '-e', 'POSTGRES_DB=chatapp_test',
      '-e', 'POSTGRES_USER=chatapp',
      '-e', 'POSTGRES_PASSWORD=test',
      '-p', `${envPg || '55432'}:5432`,
      'postgres:16-alpine',
    ];

  let code = run('docker', pgRunArgs);
  if (code !== 0) process.exit(code);

  const redisRunArgs = useDynamicHostPorts
    ? ['run', '-d', '--name', REDIS_CONTAINER, '-P', 'redis:7-alpine']
    : ['run', '-d', '--name', REDIS_CONTAINER, '-p', `${envRedis || '56379'}:6379`, 'redis:7-alpine'];

  code = run('docker', redisRunArgs);
  if (code !== 0) process.exit(code);

  // CI: cold image pull + Postgres init can exceed 45s on busy self-hosted runners.
  const pgWaitMs = isCiEnvironment ? 120_000 : 45_000;
  try {
    waitFor(
      'docker',
      ['exec', PG_CONTAINER, 'pg_isready', '-U', 'chatapp', '-d', 'chatapp_test'],
      pgWaitMs,
      1_000,
      'Postgres',
    );
  } catch (e) {
    console.error(`--- docker logs ${PG_CONTAINER} (Postgres wait failed) ---`);
    dockerLogsTail(PG_CONTAINER);
    console.error(`--- docker inspect State ${PG_CONTAINER} ---`);
    dockerInspectState(PG_CONTAINER);
    throw e;
  }
  waitFor('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'ping'], 20_000, 1_000, 'Redis');

  if (useDynamicHostPorts) {
    return {
      pgPort: getDockerPublishPort(PG_CONTAINER, '5432'),
      redisPort: getDockerPublishPort(REDIS_CONTAINER, '6379'),
    };
  }
  return {
    pgPort: envPg || '55432',
    redisPort: envRedis || '56379',
  };
}

function runLocalTests({ pgPort, redisPort }) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL || `postgres://chatapp:test@127.0.0.1:${pgPort}/chatapp_test`,
    REDIS_URL: process.env.REDIS_URL || `redis://127.0.0.1:${redisPort}`,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'test-secret',
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'test-refresh',
    DISABLE_SEARCH_INIT: process.env.DISABLE_SEARCH_INIT || 'true',
  };

  let code = run('npm', ['run', 'migrate'], { env });
  if (code !== 0) return code;

  const effectiveJestArgs = getEffectiveJestArgs();
  const testArgs = effectiveJestArgs.length ? ['run', 'test:raw', '--', ...effectiveJestArgs] : ['run', 'test:raw'];
  code = run('npm', testArgs, { env });
  return code;
}

function runCiStyleTests() {
  const env = {
    ...process.env,
    DISABLE_SEARCH_INIT: process.env.DISABLE_SEARCH_INIT || 'true',
  };
  const effectiveJestArgs = getEffectiveJestArgs();
  const testArgs = effectiveJestArgs.length ? ['run', 'test:raw', '--', ...effectiveJestArgs] : ['run', 'test:raw'];
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
  const ports = startContainers();
  exitCode = runLocalTests(ports);
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
