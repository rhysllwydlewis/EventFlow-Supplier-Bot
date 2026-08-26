import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) {
    return redis;
  }

  redis = new Redis(env.REDIS_URL, {
    family: 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    connectionName: 'eventflow-supplier-bot',
  });

  redis.on('error', error => {
    logger.error({ err: error }, 'Supplier Bot Redis error');
  });

  return redis;
}

export async function connectRedis(): Promise<Redis> {
  const connection = getRedis();
  if (connection.status === 'wait') {
    await connection.connect();
  }
  await connection.ping();
  logger.info('Connected to Supplier Bot Redis');
  return connection;
}

export async function closeRedis(): Promise<void> {
  if (!redis) {
    return;
  }
  await redis.quit();
  redis = null;
}
