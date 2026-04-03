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
const isProduction = process.env.NODE_ENV === 'production';
const serviceName = process.env.LOG_SERVICE_NAME || 'chatapp-api';

const logger = pino({
  name: serviceName,
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  base: {
    service: serviceName,
    env: process.env.NODE_ENV || 'development',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
      'headers["set-cookie"]',
      'password',
      '*.password',
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'pendingToken',
      '*.pendingToken',
      'linkToken',
      '*.linkToken',
    ],
    censor: '[Redacted]',
  },
  ...(devTransport ? { transport: devTransport } : {}),
});

module.exports = logger;
