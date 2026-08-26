import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'eventflow-supplier-bot',
    environment: env.NODE_ENV,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'CONTROL_ADMIN_KEY',
      'CONTROL_SESSION_SECRET',
      'OPENAI_API_KEY',
      'BRAVE_API_KEY',
      'EVENTFLOW_BOT_HMAC_SECRET',
    ],
    censor: '[REDACTED]',
  },
});
