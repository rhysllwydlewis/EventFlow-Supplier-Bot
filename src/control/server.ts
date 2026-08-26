import { hostname } from 'node:os';
import path from 'node:path';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { z } from 'zod';
import { env } from '../config/env.js';
import { campaignSchema } from '../domain/campaign.js';
import { botSettingsSchema } from '../domain/settings.js';
import { logger } from '../lib/logger.js';
import { closeMongo, ensureMongoIndexes, getDatabase } from '../lib/mongo.js';
import { closeRedis, connectRedis } from '../lib/redis.js';
import { getQueue, getQueueCounts, closeQueues } from '../queues/index.js';
import { createCampaign, ensurePilotCampaign, listCampaigns, updateCampaign } from '../repositories/campaign.repository.js';
import { countCandidatesSince, listCandidates } from '../repositories/candidate.repository.js';
import { heartbeatIsFresh, listHeartbeats, writeHeartbeat } from '../repositories/heartbeat.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { listShadowProfiles } from '../repositories/shadow-profile.repository.js';
import { getTodayAiReservedGbp } from '../services/ai-budget.service.js';
import { getTodayAiUsage } from '../services/ai-usage.service.js';
import { getTodayCrawlCount } from '../services/crawl-budget.service.js';
import { seedCandidate } from '../services/manual-seed.service.js';
import {
  drainBot,
  emergencyStopBot,
  pauseBot,
  playBot,
  updateRuntimeSettings,
} from '../services/runtime-control.service.js';
import { loginWithAdminKey, logout, requireCsrf, requireSession, sessionInfo } from './auth.js';

const VERSION = '0.3.0';
const app = express();

const settingsPatchSchema = botSettingsSchema
  .omit({ id: true, updatedAt: true, updatedBy: true })
  .partial();
const campaignCreateSchema = campaignSchema
  .pick({
    name: true,
    categories: true,
    locations: true,
    dailyTarget: true,
    dailyHardLimit: true,
    minimumPublicationQuality: true,
    priority: true,
  });
const campaignPatchSchema = campaignSchema
  .omit({ id: true, createdAt: true })
  .partial();
const manualSeedSchema = z.object({
  url: z.string().url(),
  campaignId: z.string().min(1).optional(),
  categoryHint: z.string().min(1).max(100).optional(),
  locationHint: z.string().min(1).max(180).optional(),
  titleHint: z.string().min(1).max(300).optional(),
});

function startOfUtcDayIso(): string {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString();
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const existing = loginAttempts.get(key);
  const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + 15 * 60_000 };
  bucket.count += 1;
  loginAttempts.set(key, bucket);
  if (bucket.count > 10) {
    res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    return;
  }
  next();
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'supplier-bot-control', version: VERSION });
});

app.get('/ready', async (_req, res) => {
  try {
    const db = await getDatabase();
    await db.command({ ping: 1 });
    const redis = await connectRedis();
    await redis.ping();
    res.json({ ready: true });
  } catch (error) {
    logger.error({ err: error }, 'Readiness check failed');
    res.status(503).json({ ready: false });
  }
});

app.post('/api/auth/login', loginRateLimit, loginWithAdminKey);
app.get('/api/auth/session', sessionInfo);
app.post('/api/auth/logout', requireSession, requireCsrf, logout);

app.use('/api', requireSession);

app.get('/api/status', async (_req, res, next) => {
  try {
    const [settings, heartbeats, queues, candidatesToday, crawlsToday, aiReservedGbp, aiUsage] = await Promise.all([
      getSettings(),
      listHeartbeats(),
      getQueueCounts(),
      countCandidatesSince(startOfUtcDayIso()),
      getTodayCrawlCount(),
      getTodayAiReservedGbp(),
      getTodayAiUsage(),
    ]);
    const now = Date.now();
    const workers = heartbeats.map(item => ({ ...item, fresh: heartbeatIsFresh(item, now) }));
    const workerHealthy = workers.some(item => item.processType === 'worker' && item.fresh && item.status === 'ready');
    res.json({
      version: VERSION,
      settings,
      workers,
      workerHealthy,
      queues,
      metrics: {
        candidatesToday,
        crawlsToday,
        aiReservedGbp,
        aiCallsToday: aiUsage?.calls ?? 0,
        aiInputTokensToday: aiUsage?.inputTokens ?? 0,
        aiOutputTokensToday: aiUsage?.outputTokens ?? 0,
        aiEstimatedCostGbpToday: aiUsage?.estimatedCostGbp ?? 0,
      },
      providerCapabilities: {
        braveConfigured: Boolean(env.BRAVE_API_KEY),
        bravePersistenceAllowed: env.BRAVE_PERSISTENCE_ALLOWED,
        openAiConfigured: Boolean(env.OPENAI_API_KEY),
        eventFlowIntegrationConfigured: Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET),
      },
      safetyCeilings: {
        profilesPerDay: env.ABSOLUTE_MAX_PROFILES_PER_DAY,
        crawlsPerDay: env.ABSOLUTE_MAX_CRAWLS_PER_DAY,
        aiSpendGbpPerDay: env.ABSOLUTE_MAX_AI_SPEND_GBP_PER_DAY,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', requireCsrf, async (req, res, next) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    res.json(await updateRuntimeSettings(patch, 'control-admin'));
  } catch (error) {
    next(error);
  }
});

app.post('/api/control/:action', requireCsrf, async (req, res, next) => {
  try {
    const action = req.params.action;
    const actor = 'control-admin';
    if (action === 'play') {
      res.json(await playBot(actor));
      return;
    }
    if (action === 'pause') {
      res.json(await pauseBot(actor));
      return;
    }
    if (action === 'drain') {
      res.json(await drainBot(actor));
      return;
    }
    if (action === 'emergency-stop') {
      res.json(await emergencyStopBot(actor));
      return;
    }
    res.status(404).json({ error: 'Unknown control action' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/run-now', requireCsrf, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.runState !== 'running') {
      res.status(409).json({ error: 'Bot must be running before a manual planning cycle can start' });
      return;
    }
    const job = await getQueue('orchestration').add(
      'coverage-plan',
      { trigger: 'manual', requestedAt: new Date().toISOString() },
      { jobId: `manual-plan-${Date.now()}` },
    );
    res.status(202).json({ accepted: true, jobId: job.id });
  } catch (error) {
    next(error);
  }
});

app.get('/api/campaigns', async (_req, res, next) => {
  try {
    res.json({ items: await listCampaigns() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/campaigns', requireCsrf, async (req, res, next) => {
  try {
    const input = campaignCreateSchema.parse(req.body);
    res.status(201).json(await createCampaign(input));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/campaigns/:id', requireCsrf, async (req, res, next) => {
  try {
    const patch = campaignPatchSchema.parse(req.body);
    res.json(await updateCampaign(req.params.id, patch));
  } catch (error) {
    next(error);
  }
});

app.get('/api/candidates', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ items: await listCandidates(limit) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/candidates/seed', requireCsrf, async (req, res, next) => {
  try {
    const input = manualSeedSchema.parse(req.body);
    const result = await seedCandidate(input);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/shadow-profiles', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ items: await listShadowProfiles(limit) });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(process.cwd(), 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'control.html'));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation failed', details: error.issues });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  logger.error({ err: error }, 'Control API request failed');
  res.status(500).json({ error: message });
});

const workerId = `control-${hostname()}-${process.pid}`;
const startedAt = new Date().toISOString();
let heartbeatTimer: NodeJS.Timeout | null = null;

async function heartbeat(status: 'starting' | 'ready' | 'stopping'): Promise<void> {
  await writeHeartbeat({
    workerId,
    processType: 'control',
    hostname: hostname(),
    pid: process.pid,
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    version: VERSION,
  });
}

async function start(): Promise<void> {
  await ensureMongoIndexes();
  await connectRedis();
  await ensurePilotCampaign();
  await getSettings();
  await heartbeat('starting');

  const server = app.listen(env.CONTROL_PORT, '0.0.0.0', () => {
    logger.info({ port: env.CONTROL_PORT }, 'Supplier Bot Control Centre listening');
  });

  await heartbeat('ready');
  heartbeatTimer = setInterval(() => {
    void heartbeat('ready').catch(error => logger.error({ err: error }, 'Control heartbeat failed'));
  }, 30_000);
  heartbeatTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Control Centre shutting down');
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await heartbeat('stopping').catch(() => undefined);
    server.close();
    await closeQueues();
    await closeRedis();
    await closeMongo();
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

start().catch(error => {
  logger.fatal({ err: error }, 'Failed to start Supplier Bot Control Centre');
  process.exit(1);
});
