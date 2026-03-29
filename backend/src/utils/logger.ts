'use strict';

const pino = require('pino');

function createDevTransport() {
  if (process.env.NODE_ENV !== 'development') return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true } };
  } catch {
    return undefined;
  }
}

const devTransport = createDevTransport();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(devTransport ? { transport: devTransport } : {}),
});

module.exports = logger;
