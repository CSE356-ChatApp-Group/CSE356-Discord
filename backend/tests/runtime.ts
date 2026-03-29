/**
 * Shared CommonJS loader for tests.
 *
 * Keeps require() usage centralized and typed as `any` to avoid TS friction when
 * importing backend modules that export via module.exports.
 */

import { createRequire } from 'module';

const cjsRequire = createRequire(__filename);

export const request: any = cjsRequire('supertest');
export const app: any = cjsRequire('../src/app');
export const wsServer: any = cjsRequire('../src/websocket/server');
export const pool: any = cjsRequire('../src/db/pool').pool;
export const closeRedisConnections: any = cjsRequire('../src/db/redis').closeRedisConnections;
