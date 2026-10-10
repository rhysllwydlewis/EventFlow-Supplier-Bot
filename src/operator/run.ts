import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BotSettings } from '../domain/settings.js';
import { assess, settingsChanges, type Finding, type RailwayObservation } from './assess.js';
import { ControlApiError, type ControlClient, type ComplianceOverview } from './client.js';
import { decideRecommendations, DEFAULT_STALE_AFTER_HOURS, type PolicyVerdict } from './policy.js';

export const RUN_LOG_SCHEMA_VERSION = 1;
// Hard ceiling on approvals per run, whatever the policy says: a policy bug
// can at worst loosen this many things before a human sees the log.
export const MAX_APPROVALS_PER_RUN = 3;
const OWNER_REMINDER_DAYS = 7;

export interface RecommendationOutcome {
  applied: boolean;
  httpStatus: number | null;
  detail: string;
}

export interface LoggedRecommendation extends PolicyVerdict {
  outcome: RecommendationOutcome;
}

export interface OwnerQueueItem {
  fingerprint: string;
  summary: string;
  rule: string;
  firstSeenAt: string;
  count: number;
}

export interface RunLog {
  schemaVersion: typeof RUN_LOG_SCHEMA_VERSION;
  runId: string;
  startedAt: string;
  finishedAt: string;
  applied: boolean;
  controlHost: string;
  botVersion: string | null;
  settings: BotSettings | null;
  supervisor: { lastCycleAt: string | null; lastKind: string | null; lastSkippedReason: string | null };
  queues: Record<string, { waiting: number; failed: number }>;
  metrics: Record<string, number>;
  compliance: ComplianceOverview | null;
  findings: Finding[];
  recommendations: LoggedRecommendation[];
  counts: { pending: number; approved: number; dismissed: number; escalated: number };
  ownerQueue: OwnerQueueItem[];
  notifyOwner: { needed: boolean; reasons: string[] };
  lastOwnerNotifiedAt: string | null;
  railway: RailwayObservation | null;
}

export interface RunOptions {
  apply: boolean;
  logDir: string;
  railway: RailwayObservation | null;
  staleAfterHours?: number;
  now?: () => number;
}

export function runIdFor(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
}

export async function loadPreviousRun(logDir: string): Promise<RunLog | null> {
  let names: string[];
  try {
    names = (await readdir(logDir)).filter(name => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (const name of names.reverse()) {
    try {
      const parsed = JSON.parse(await readFile(join(logDir, name), 'utf8')) as RunLog;
      if (parsed.schemaVersion === RUN_LOG_SCHEMA_VERSION) return parsed;
    } catch {
      // Skip unreadable files; fall back to the next-newest.
    }
  }
  return null;
}

function buildOwnerQueue(escalated: PolicyVerdict[], previous: RunLog | null, nowIso: string): OwnerQueueItem[] {
  const seen = new Map(previous?.ownerQueue.map(item => [item.fingerprint, item.firstSeenAt]) ?? []);
  const grouped = new Map<string, OwnerQueueItem>();
  for (const item of escalated) {
    const existing = grouped.get(item.fingerprint);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(item.fingerprint, {
      fingerprint: item.fingerprint,
      summary: item.summary,
      rule: item.rule,
      firstSeenAt: seen.get(item.fingerprint) ?? nowIso,
      count: 1,
    });
  }
  return [...grouped.values()];
}

function decideNotify(
  findings: Finding[],
  ownerQueue: OwnerQueueItem[],
  previous: RunLog | null,
  nowMs: number,
): { needed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const finding of findings) {
    if (finding.severity === 'alert') reasons.push(`ALERT ${finding.code}: ${finding.message}`);
  }
  const previouslyQueued = new Set(previous?.ownerQueue.map(item => item.fingerprint) ?? []);
  for (const item of ownerQueue) {
    if (!previouslyQueued.has(item.fingerprint)) reasons.push(`NEW decision for you: ${item.summary}`);
  }
  const lastNotified = previous?.lastOwnerNotifiedAt ? Date.parse(previous.lastOwnerNotifiedAt) : 0;
  const reminderDue = nowMs - lastNotified > OWNER_REMINDER_DAYS * 86_400_000;
  if (ownerQueue.length > 0 && reminderDue && reasons.length === 0) {
    reasons.push(`REMINDER: ${ownerQueue.length} decision(s) still waiting on you`);
  }
  return { needed: reasons.length > 0, reasons };
}

function controlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'unknown';
  }
}

export async function runOperator(client: ControlClient, baseUrl: string, options: RunOptions): Promise<RunLog> {
  const nowMs = (options.now ?? Date.now)();
  const startedAt = new Date(nowMs).toISOString();
  const previous = await loadPreviousRun(options.logDir);

  const [health, ready] = await Promise.all([client.probe('/health'), client.probe('/ready')]);
  const baseLog = {
    schemaVersion: RUN_LOG_SCHEMA_VERSION,
    runId: runIdFor(nowMs),
    startedAt,
    applied: options.apply,
    controlHost: controlHost(baseUrl),
    railway: options.railway,
  } as const;

  try {
    await client.login();
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    // Cannot log in (key rotated, rate-limited, control down): the run still
    // produces a log and an alert rather than failing silently.
    const findings: Finding[] = [
      { severity: 'alert', code: 'operator_cannot_login', message: error.message },
      ...(health.ok ? [] : [{ severity: 'alert' as const, code: 'control_unhealthy', message: `control /health returned HTTP ${health.httpStatus}` }]),
    ];
    return {
      ...baseLog,
      finishedAt: new Date().toISOString(),
      botVersion: null,
      settings: null,
      supervisor: { lastCycleAt: null, lastKind: null, lastSkippedReason: null },
      queues: {},
      metrics: {},
      compliance: null,
      findings,
      recommendations: [],
      counts: { pending: 0, approved: 0, dismissed: 0, escalated: 0 },
      ownerQueue: previous?.ownerQueue ?? [],
      notifyOwner: decideNotify(findings, previous?.ownerQueue ?? [], previous, nowMs),
      lastOwnerNotifiedAt: previous?.lastOwnerNotifiedAt ?? null,
    };
  }

  try {
    const [status, compliance, campaigns, agentLog, pending] = await Promise.all([
      client.status(),
      client.compliance().catch(() => null),
      client.campaigns(),
      client.agentLog(10),
      client.pendingRecommendations(200),
    ]);

    const verdicts = decideRecommendations(pending, {
      now: nowMs,
      settings: status.settings,
      campaigns,
      staleAfterHours: options.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS,
    });

    let approvalsUsed = 0;
    const recommendations: LoggedRecommendation[] = [];
    for (const verdict of verdicts) {
      let outcome: RecommendationOutcome = { applied: false, httpStatus: null, detail: options.apply ? 'left pending' : 'dry run' };
      if (verdict.decision === 'dismiss' && options.apply) {
        const result = await client.dismiss(verdict.id);
        outcome = { applied: result.ok, httpStatus: result.httpStatus, detail: result.detail || (result.ok ? 'dismissed' : 'not dismissed') };
      } else if (verdict.decision === 'approve' && options.apply) {
        if (approvalsUsed >= MAX_APPROVALS_PER_RUN) {
          outcome = { applied: false, httpStatus: null, detail: `skipped: per-run approval cap (${MAX_APPROVALS_PER_RUN}) reached` };
        } else {
          approvalsUsed += 1;
          const result = await client.approve(verdict.id);
          outcome = { applied: result.ok, httpStatus: result.httpStatus, detail: result.detail || (result.ok ? 'approved' : 'not approved') };
        }
      }
      recommendations.push({ ...verdict, outcome });
    }

    const escalated = recommendations.filter(item => item.decision === 'escalate' || (item.decision === 'approve' && !item.outcome.applied && options.apply));
    const ownerQueue = buildOwnerQueue(escalated, previous, startedAt);

    const findings = assess({
      now: nowMs,
      status,
      compliance,
      agentLog,
      health,
      ready,
      railway: options.railway,
      previousSettings: previous?.settings ?? null,
    });
    const notifyOwner = decideNotify(findings, ownerQueue, previous, nowMs);
    const latest = agentLog[0];

    return {
      ...baseLog,
      finishedAt: new Date().toISOString(),
      botVersion: status.version,
      settings: status.settings,
      supervisor: {
        lastCycleAt: latest?.createdAt ?? null,
        lastKind: latest?.kind ?? null,
        lastSkippedReason: latest?.skippedReason ?? null,
      },
      queues: Object.fromEntries(Object.entries(status.queues).map(([name, counts]) => [name, { waiting: counts.waiting, failed: counts.failed }])),
      metrics: status.metrics,
      compliance,
      findings,
      recommendations,
      counts: {
        pending: recommendations.length,
        approved: recommendations.filter(item => item.decision === 'approve' && item.outcome.applied).length,
        dismissed: recommendations.filter(item => item.decision === 'dismiss' && item.outcome.applied).length,
        escalated: ownerQueue.length,
      },
      ownerQueue,
      notifyOwner,
      lastOwnerNotifiedAt: notifyOwner.needed ? startedAt : (previous?.lastOwnerNotifiedAt ?? null),
    };
  } finally {
    await client.logout();
  }
}

export function renderMarkdown(log: RunLog, previous: RunLog | null): string {
  const lines: string[] = [];
  lines.push(`# Supplier Bot operator run ${log.runId}`, '');
  lines.push(`- Mode: ${log.applied ? '**apply**' : 'dry run (nothing changed)'}; bot v${log.botVersion ?? '?'} on ${log.controlHost}`);
  if (log.settings) {
    const s = log.settings;
    lines.push(
      `- Settings: mode=${s.mode} runState=${s.runState} discovery=${s.discoveryEnabled} publishing=${s.publishingEnabled} refresh=${s.refreshEnabled} claimNotices=${s.claimNoticesEnabled} marketing=${s.marketingEnabled} seoIndexing=${s.seoIndexingEnabled}; daily ${s.dailyTarget}/${s.dailyHardLimit}, crawls ${s.maxCrawlsPerDay}, quality>=${s.minimumPublicationQuality}, AI cap £${s.softAiSpendGbpPerDay}/£${s.hardAiSpendGbpPerDay} (last changed by ${s.updatedBy} at ${s.updatedAt})`,
    );
    if (previous?.settings) {
      const changes = settingsChanges(previous.settings, s);
      if (changes.length) lines.push(`- Changed since last run: ${changes.join('; ')}`);
    }
  }
  lines.push(`- Supervisor: last cycle ${log.supervisor.lastCycleAt ?? 'never'} (${log.supervisor.lastKind ?? 'n/a'}${log.supervisor.lastSkippedReason ? `, skipped: ${log.supervisor.lastSkippedReason}` : ''})`);
  if (log.compliance) {
    const c = log.compliance;
    lines.push(`- Compliance: ${c.totalProfiles} profiles, ${c.publicationEligible} publication-eligible, ${c.review} in review, ${c.blocked} blocked, ${c.seoReady} SEO-ready`);
  }
  const m = log.metrics;
  if (Object.keys(m).length) {
    lines.push(`- Today: ${m.candidatesToday ?? 0} candidates, ${m.crawlsToday ?? 0} crawls, ${m.braveSearchesToday ?? 0} searches, AI £${(m.aiEstimatedCostGbpToday ?? 0).toFixed(2)} (${m.aiCallsToday ?? 0} calls)`);
  }
  if (log.railway) {
    lines.push(`- Railway (${log.railway.checkedAt}): ${log.railway.services.map(item => `${item.name}=${item.status}`).join(', ') || 'no services reported'}`);
  }

  lines.push('', '## Findings', '');
  if (log.findings.length === 0) lines.push('None.');
  for (const finding of log.findings) lines.push(`- **${finding.severity}** \`${finding.code}\` ${finding.message}`);

  lines.push('', '## Recommendations', '');
  lines.push(`${log.counts.pending} pending: ${log.counts.approved} approved, ${log.counts.dismissed} dismissed, ${log.counts.escalated} distinct decision(s) left for the owner.`, '');
  for (const rec of log.recommendations) {
    const result = rec.outcome.applied ? 'done' : rec.outcome.detail;
    lines.push(`- \`${rec.id}\` **${rec.decision}** (${rec.rule}; ${result}) — ${rec.summary}. ${rec.reason}.`);
  }

  lines.push('', '## Waiting on the owner', '');
  if (log.ownerQueue.length === 0) lines.push('Nothing.');
  for (const item of log.ownerQueue) lines.push(`- ${item.summary} (first seen ${item.firstSeenAt}${item.count > 1 ? `, ${item.count} identical requests` : ''}; ${item.rule})`);

  lines.push('', '## Notify owner', '');
  lines.push(log.notifyOwner.needed ? log.notifyOwner.reasons.map(reason => `- ${reason}`).join('\n') : 'No: nothing new needs the owner.', '');
  return lines.join('\n');
}

export async function writeRunLog(log: RunLog, previous: RunLog | null, logDir: string): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(logDir, { recursive: true });
  const jsonPath = join(logDir, `${log.runId}.json`);
  const mdPath = join(logDir, `${log.runId}.md`);
  await writeFile(jsonPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderMarkdown(log, previous), 'utf8');
  return { jsonPath, mdPath };
}
