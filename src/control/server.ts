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
import {
  getComplianceAssessmentsForCandidates,
  getComplianceOverview,
  listComplianceAssessments,
} from '../repositories/compliance-assessment.repository.js';
import { heartbeatIsFresh, listHeartbeats, writeHeartbeat } from '../repositories/heartbeat.repository.js';
import { listAuditEventsByAction } from '../repositories/audit.repository.js';
import { listPublishedDomains, listRecentPublishedSuppliers } from '../repositories/published-supplier.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { listShadowProfiles } from '../repositories/shadow-profile.repository.js';
import { getTodayAiReservedGbp } from '../services/ai-budget.service.js';
import { getTodayAiUsage } from '../services/ai-usage.service.js';
import { getTodayCrawlCount } from '../services/crawl-budget.service.js';
import { getDiscoveryAudit } from '../services/discovery-audit.service.js';
import { getLiveActivity } from '../services/live-activity.service.js';
import { seedCandidate } from '../services/manual-seed.service.js';
import { getPhase3ValidationReport } from '../services/phase3-validation.service.js';
import {
  drainBot,
  emergencyStopBot,
  hardResetBot,
  pauseBot,
  playBot,
  updateRuntimeSettings,
} from '../services/runtime-control.service.js';
import { rejectShadowProfile } from '../services/shadow-profile-review.service.js';
import { canonicalDomain } from '../utils/url.js';
import { loginWithAdminKey, logout, requireCsrf, requireSession, sessionInfo } from './auth.js';

const VERSION = '0.8.0';
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
    if (action === 'hard-reset') {
      // Server-side confirmation gate independent of the dashboard's own
      // typed-confirmation prompt -- this is a destructive, irreversible
      // action, so it must not be triggerable by a bare POST from anywhere
      // (a misclick, a replayed request, a future UI bug) without an
      // explicit, deliberate confirmation string in the request itself.
      if (req.body?.confirm !== 'RESET') {
        res.status(400).json({ error: 'Hard reset requires { "confirm": "RESET" } in the request body' });
        return;
      }
      res.json(await hardResetBot(actor));
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

    const candidatesToday = await countCandidatesSince(startOfUtcDayIso());
    if (candidatesToday >= settings.dailyHardLimit) {
      res.status(409).json({
        error: `Daily candidate hard limit reached (${candidatesToday}/${settings.dailyHardLimit}). No new discovery can be scheduled until the next UTC day.`,
      });
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

app.get('/api/discovery-audit', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
    res.json(await getDiscoveryAudit(limit));
  } catch (error) {
    next(error);
  }
});

app.get('/api/activity', async (_req, res, next) => {
  try {
    res.json({ items: await getLiveActivity() });
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

app.get('/api/shadow-profile-reviews', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const [profiles, publishedDomains] = await Promise.all([
      listShadowProfiles(limit),
      listPublishedDomains(),
    ]);
    // Once a profile is actually live on EventFlow there's nothing left for
    // an operator to decide here -- leaving it showing "Ready" (compliance
    // eligibility, not publication status) reads as "still waiting on you"
    // when it's already done. It moves to /api/published-suppliers instead.
    const pending = profiles.filter(profile => {
      try {
        return !publishedDomains.has(canonicalDomain(profile.website));
      } catch {
        return true;
      }
    });
    const assessments = await getComplianceAssessmentsForCandidates(pending.map(profile => profile.candidateId));
    const byCandidate = new Map(assessments.map(assessment => [assessment.candidateId, assessment]));
    res.json({
      items: pending.map(profile => ({
        profile,
        assessment: byCandidate.get(profile.candidateId) ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/published-suppliers', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ items: await listRecentPublishedSuppliers(limit) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/removed-candidates', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const events = await listAuditEventsByAction('shadow_profile.rejected', limit);
    res.json({
      items: events.map(event => ({
        candidateId: event.details.candidateId ?? null,
        businessName: event.details.businessName ?? null,
        canonicalDomain: event.details.canonicalDomain ?? null,
        removedAt: event.createdAt,
        removedBy: event.actor,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/shadow-profiles/:candidateId', requireCsrf, async (req, res, next) => {
  try {
    const candidateId = String(req.params.candidateId ?? '');
    if (!candidateId) {
      res.status(400).json({ error: 'candidateId is required' });
      return;
    }
    await rejectShadowProfile(candidateId, 'control-admin');
    res.status(204).end();
  } catch (error) {
    if (error instanceof Error && error.message === 'Shadow profile not found') {
      res.status(404).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get('/api/compliance-assessments', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ items: await listComplianceAssessments(limit) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/compliance-overview', async (_req, res, next) => {
  try {
    res.json(await getComplianceOverview());
  } catch (error) {
    next(error);
  }
});

app.get('/api/phase3-validation', async (_req, res, next) => {
  try {
    const settings = await getSettings();
    res.json(await getPhase3ValidationReport(settings));
  } catch (error) {
    next(error);
  }
});

// Neither express.static's defaults nor a bare res.sendFile() set an
// explicit Cache-Control header -- only Last-Modified/ETag. Per RFC 7234
// §4.2.2, a browser without an explicit directive MAY apply heuristic
// freshness based on Last-Modified, which for an admin dashboard that
// rarely changes can be long enough that a plain refresh serves straight
// from disk cache without ever asking the server -- exactly the "I
// refreshed and still don't see the new button" report this caused after
// a deploy. This is a control panel with embedded inline JS, not a public
// asset: it must always be fetched fresh.
//
// `index: false` disables express.static's default behaviour of silently
// serving a same-directory index.html for GET / ahead of every other
// route. That default previously let a stray, long-stale public/index.html
// (an old dashboard duplicate never cleaned up after control.html took
// over) shadow the catch-all route below and serve on every request,
// completely independent of the browser's cache, DNS or extensions --
// every "the deploy didn't apply" report was this file, not the deployed
// one. control.html is the single source of truth for this route.
app.use(express.static(path.join(process.cwd(), 'public'), {
  index: false,
  setHeaders: res => res.set('Cache-Control', 'no-store'),
}));
app.get('/{*splat}', (_req, res) => {
  res.set('Cache-Control', 'no-store');
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