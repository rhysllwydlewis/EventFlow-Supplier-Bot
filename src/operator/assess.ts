import { z } from 'zod';
import type { AgentLogEntry } from '../domain/agent-log.js';
import type { BotSettings } from '../domain/settings.js';
import type { ComplianceOverview, StatusSnapshot } from './client.js';

export type FindingSeverity = 'alert' | 'warn' | 'info';

export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
}

// What the routine's Railway pass (an outside-in check the bot cannot do on
// itself) hands to the script. The script owns validation and alerting so the
// rules live in code and in the log, not in a prompt.
export const railwayObservationSchema = z.object({
  checkedAt: z.string(),
  services: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        status: z.string().min(1).max(40),
        commit: z.string().max(80).optional(),
        deployedAt: z.string().max(40).optional(),
      }),
    )
    .max(20),
  recentErrors: z
    .object({
      count: z.number().int().min(0),
      windowHours: z.number().min(0),
      samples: z.array(z.string().max(300)).max(5),
    })
    .optional(),
  notes: z.array(z.string().max(300)).max(10).optional(),
});
export type RailwayObservation = z.infer<typeof railwayObservationSchema>;

// The supervisor runs every 6h (src/worker/index.ts SUPERVISOR_CYCLE_INTERVAL_MS).
const SUPERVISOR_EXPECTED_EVERY_HOURS = 6;
const SUPERVISOR_MAX_SILENCE_HOURS = SUPERVISOR_EXPECTED_EVERY_HOURS * 2 + 1;
const QUEUE_BACKLOG_WARN = 100;
const SPEND_WARN_FRACTION = 0.8;
const BAD_DEPLOY_STATES = new Set(['FAILED', 'CRASHED']);

export interface AssessInput {
  now: number;
  status: StatusSnapshot;
  compliance: ComplianceOverview | null;
  agentLog: AgentLogEntry[];
  health: { ok: boolean; httpStatus: number };
  ready: { ok: boolean; httpStatus: number };
  railway: RailwayObservation | null;
  previousSettings: BotSettings | null;
}

const WATCHED_SETTINGS: Array<keyof BotSettings> = [
  'mode',
  'runState',
  'discoveryEnabled',
  'publishingEnabled',
  'refreshEnabled',
  'claimNoticesEnabled',
  'marketingEnabled',
  'seoIndexingEnabled',
  'dailyTarget',
  'dailyHardLimit',
  'maxCrawlsPerDay',
  'minimumPublicationQuality',
  'softAiSpendGbpPerDay',
  'hardAiSpendGbpPerDay',
  'activeCampaignId',
];

export function settingsChanges(previous: BotSettings, current: BotSettings): string[] {
  return WATCHED_SETTINGS.filter(key => previous[key] !== current[key]).map(
    key => `${key}: ${String(previous[key])} -> ${String(current[key])}`,
  );
}

export function assess(input: AssessInput): Finding[] {
  const { status, compliance, agentLog, health, ready, railway, previousSettings, now } = input;
  const findings: Finding[] = [];
  const add = (severity: FindingSeverity, code: string, message: string): void => {
    findings.push({ severity, code, message });
  };

  if (!health.ok) add('alert', 'control_unhealthy', `control /health returned HTTP ${health.httpStatus}`);
  if (!ready.ok) add('alert', 'control_not_ready', `control /ready returned HTTP ${ready.httpStatus} (Mongo or Redis unreachable)`);

  if (!status.workerHealthy) add('alert', 'worker_unhealthy', 'no fresh, ready worker heartbeat');
  if (status.operatorIdle.alert) {
    add('alert', 'bot_idle', `bot idle alert (cause: ${status.operatorIdle.cause ?? 'unknown'}, blocked: ${status.operatorIdle.blockedReason ?? 'none'})`);
  }
  const { runState } = status.settings;
  if (runState === 'emergency_stopped') add('alert', 'emergency_stopped', 'bot is emergency-stopped');
  else if (runState === 'paused' || runState === 'stopped') add('warn', 'not_running', `bot runState is ${runState}`);

  for (const [name, counts] of Object.entries(status.queues)) {
    if (counts.waiting > QUEUE_BACKLOG_WARN) add('warn', 'queue_backlog', `${name} queue has ${counts.waiting} waiting`);
  }

  const latest = agentLog[0];
  if (!latest) {
    add('warn', 'supervisor_no_log', 'the in-app supervisor has no log entries (disabled or never ran)');
  } else {
    const ageHours = (now - Date.parse(latest.createdAt)) / 3_600_000;
    if (ageHours > SUPERVISOR_MAX_SILENCE_HOURS) {
      add('warn', 'supervisor_silent', `last supervisor cycle was ${ageHours.toFixed(1)}h ago (expected every ${SUPERVISOR_EXPECTED_EVERY_HOURS}h)`);
    }
    if (latest.kind === 'ai_skipped') {
      add('warn', 'supervisor_skipped', `last supervisor cycle was skipped: ${latest.skippedReason ?? 'unknown'}`);
    }
  }

  const spend = status.metrics.aiEstimatedCostGbpToday ?? 0;
  if (status.settings.softAiSpendGbpPerDay > 0 && spend >= status.settings.softAiSpendGbpPerDay * SPEND_WARN_FRACTION) {
    add('warn', 'ai_spend_high', `AI spend today £${spend.toFixed(2)} is over ${SPEND_WARN_FRACTION * 100}% of the £${status.settings.softAiSpendGbpPerDay} soft cap`);
  }

  if (compliance && compliance.totalProfiles > compliance.assessed) {
    add('warn', 'compliance_backlog', `${compliance.totalProfiles - compliance.assessed} profiles not yet compliance-assessed`);
  }

  if (previousSettings) {
    const changes = settingsChanges(previousSettings, status.settings);
    if (changes.length) {
      add('info', 'settings_changed', `settings changed since the last run (by ${status.settings.updatedBy}): ${changes.join('; ')}`);
    }
  }

  if (railway) {
    for (const service of railway.services) {
      if (BAD_DEPLOY_STATES.has(service.status.toUpperCase())) {
        add('alert', 'deploy_bad', `Railway ${service.name} latest deployment is ${service.status}`);
      }
    }
    if (railway.recentErrors && railway.recentErrors.count > 0) {
      add('warn', 'railway_errors', `${railway.recentErrors.count} error log lines in the last ${railway.recentErrors.windowHours}h`);
    }
  } else {
    add('info', 'railway_not_checked', 'no Railway observation supplied for this run');
  }

  return findings;
}
