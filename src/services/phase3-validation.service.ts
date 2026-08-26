import type { Filter } from 'mongodb';
import type { Candidate } from '../domain/candidate.js';
import type { ComplianceAssessment } from '../domain/compliance-assessment.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import type { BotSettings } from '../domain/settings.js';
import { getDatabase } from '../lib/mongo.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { patchSettings } from '../repositories/settings.repository.js';

export const PHASE3_VALIDATION_ID = 'phase3-shadow-validation';
export const PHASE3_TARGET_CANDIDATES = 100;

export type Phase3ValidationStatus = 'collecting' | 'draining' | 'ready_for_review' | 'completed';

export interface Phase3ValidationRun {
  id: typeof PHASE3_VALIDATION_ID;
  status: Phase3ValidationStatus;
  startedAt: string;
  completedAt?: string | null;
  campaignId?: string | null;
  targetCandidates: number;
  updatedAt: string;
}

export interface Phase3ValidationMetrics {
  candidateCount: number;
  shadowProfileCount: number;
  profileYieldPct: number;
  averagePublicationQuality: number;
  averageDataConfidence: number;
  evidenceCoveragePct: number;
  publicEmailCoveragePct: number;
  publicPhoneCoveragePct: number;
  advertisedPriceCoveragePct: number;
  packageCoveragePct: number;
  distinctCandidates: number;
  probableDuplicates: number;
  strongDuplicates: number;
  quarantinedCandidates: number;
  rejectedCandidates: number;
  publicationEligible: number;
  complianceReview: number;
  complianceBlocked: number;
  seoReady: number;
  aiEstimatedCostGbp: number;
  aiCostPerCandidateGbp: number;
}

export interface Phase3ValidationReport {
  run: Phase3ValidationRun | null;
  safety: {
    shadowMode: boolean;
    publishingOff: boolean;
    marketingOff: boolean;
    claimNoticesOff: boolean;
    seoIndexingOff: boolean;
    safeToValidate: boolean;
  };
  targetReached: boolean;
  readyForReview: boolean;
  metrics: Phase3ValidationMetrics;
}

function round(value: number, places = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? round((numerator / denominator) * 100, 1) : 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 1);
}

function isPopulated(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

export function phase3Safety(settings: BotSettings) {
  const safety = {
    shadowMode: settings.mode === 'shadow',
    publishingOff: settings.publishingEnabled === false,
    marketingOff: settings.marketingEnabled === false,
    claimNoticesOff: settings.claimNoticesEnabled === false,
    seoIndexingOff: settings.seoIndexingEnabled === false,
  };
  return { ...safety, safeToValidate: Object.values(safety).every(Boolean) };
}

export function summarizePhase3Validation(input: {
  settings: BotSettings;
  run: Phase3ValidationRun | null;
  candidates: Candidate[];
  profiles: ShadowProfile[];
  assessments: ComplianceAssessment[];
  aiEstimatedCostGbp?: number;
}): Phase3ValidationReport {
  const candidates = input.candidates;
  const profiles = input.profiles;
  const assessmentByCandidate = new Map(input.assessments.map(item => [item.candidateId, item]));
  const profileIds = new Set(profiles.map(item => item.candidateId));
  const candidateCount = candidates.length;
  const profileCount = profiles.length;

  const distinctCandidates = candidates.filter(item => item.dedupDecision === 'distinct').length;
  const probableDuplicates = candidates.filter(item => item.dedupDecision === 'probable_duplicate').length;
  const strongDuplicates = candidates.filter(item => item.dedupDecision === 'strong_duplicate').length;
  const quarantinedCandidates = candidates.filter(item => item.status === 'quarantined').length;
  const rejectedCandidates = candidates.filter(item => item.status === 'rejected').length;

  let publicationEligible = 0;
  let complianceReview = 0;
  let complianceBlocked = 0;
  let seoReady = 0;
  for (const candidate of candidates) {
    if (!profileIds.has(candidate.id)) continue;
    const assessment = assessmentByCandidate.get(candidate.id);
    if (!assessment) continue;
    if (candidate.dedupDecision === 'distinct' && assessment.publicationEligible) publicationEligible += 1;
    if (candidate.dedupDecision === 'probable_duplicate') complianceReview += 1;
    else if (candidate.dedupDecision === 'strong_duplicate') complianceBlocked += 1;
    else if (assessment.status === 'review') complianceReview += 1;
    else if (assessment.status === 'block') complianceBlocked += 1;
    if (candidate.dedupDecision === 'distinct' && assessment.seoIndexEligible) seoReady += 1;
  }

  const aiEstimatedCostGbp = Math.max(0, Number(input.aiEstimatedCostGbp) || 0);
  const target = input.run?.targetCandidates ?? PHASE3_TARGET_CANDIDATES;

  return {
    run: input.run,
    safety: phase3Safety(input.settings),
    targetReached: candidateCount >= target,
    readyForReview: candidateCount >= target && profileCount > 0,
    metrics: {
      candidateCount,
      shadowProfileCount: profileCount,
      profileYieldPct: pct(profileCount, candidateCount),
      averagePublicationQuality: average(profiles.map(item => item.publicationQuality)),
      averageDataConfidence: average(profiles.map(item => item.dataConfidence)),
      evidenceCoveragePct: pct(profiles.filter(item => item.evidenceIds.length > 0).length, profileCount),
      publicEmailCoveragePct: pct(profiles.filter(item => isPopulated(item.publicEmail)).length, profileCount),
      publicPhoneCoveragePct: pct(profiles.filter(item => isPopulated(item.publicPhone)).length, profileCount),
      advertisedPriceCoveragePct: pct(profiles.filter(item => item.advertisedPrices.length > 0).length, profileCount),
      packageCoveragePct: pct(profiles.filter(item => item.packages.length > 0).length, profileCount),
      distinctCandidates,
      probableDuplicates,
      strongDuplicates,
      quarantinedCandidates,
      rejectedCandidates,
      publicationEligible,
      complianceReview,
      complianceBlocked,
      seoReady,
      aiEstimatedCostGbp: round(aiEstimatedCostGbp, 4),
      aiCostPerCandidateGbp: candidateCount > 0 ? round(aiEstimatedCostGbp / candidateCount, 4) : 0,
    },
  };
}

async function getRun(): Promise<Phase3ValidationRun | null> {
  const db = await getDatabase();
  const record = await db.collection<Phase3ValidationRun>('validation_runs').findOne({ id: PHASE3_VALIDATION_ID });
  return record ? { ...record, id: PHASE3_VALIDATION_ID } : null;
}

async function ensureRun(settings: BotSettings): Promise<Phase3ValidationRun | null> {
  const existing = await getRun();
  if (existing) return existing;
  if (settings.runState !== 'running') return null;

  const now = new Date().toISOString();
  const run: Phase3ValidationRun = {
    id: PHASE3_VALIDATION_ID,
    status: 'collecting',
    startedAt: now,
    completedAt: null,
    campaignId: settings.activeCampaignId,
    targetCandidates: PHASE3_TARGET_CANDIDATES,
    updatedAt: now,
  };
  const db = await getDatabase();
  await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID },
    { $setOnInsert: run },
    { upsert: true },
  );
  await recordAuditEvent('phase3-validator', 'phase3.validation_started', {
    targetCandidates: PHASE3_TARGET_CANDIDATES,
    campaignId: settings.activeCampaignId,
  });
  return (await getRun()) ?? run;
}

async function loadRunData(run: Phase3ValidationRun) {
  const db = await getDatabase();
  const candidateFilter: Filter<Candidate> = { discoveredAt: { $gte: run.startedAt } };
  if (run.campaignId) candidateFilter.campaignId = run.campaignId;

  const candidates = await db.collection<Candidate>('candidates')
    .find(candidateFilter)
    .sort({ discoveredAt: 1 })
    .limit(250)
    .toArray();
  const ids = candidates.map(item => item.id);
  const [profiles, assessments, aiUsage] = await Promise.all([
    ids.length > 0
      ? db.collection<ShadowProfile>('shadow_profiles').find({ candidateId: { $in: ids } }).toArray()
      : Promise.resolve([]),
    ids.length > 0
      ? db.collection<ComplianceAssessment>('compliance_assessments').find({ candidateId: { $in: ids } }).toArray()
      : Promise.resolve([]),
    db.collection<{ provider: 'openai'; day: string; estimatedCostGbp?: number }>('ai_usage')
      .find({ provider: 'openai', day: { $gte: run.startedAt.slice(0, 10) } })
      .toArray(),
  ]);

  return {
    candidates,
    profiles,
    assessments,
    aiEstimatedCostGbp: aiUsage.reduce((sum, item) => sum + Math.max(0, Number(item.estimatedCostGbp) || 0), 0),
  };
}

export async function getPhase3ValidationReport(settings: BotSettings): Promise<Phase3ValidationReport> {
  const run = await getRun();
  if (!run) {
    return summarizePhase3Validation({ settings, run: null, candidates: [], profiles: [], assessments: [] });
  }
  const data = await loadRunData(run);
  return summarizePhase3Validation({ settings, run, ...data });
}

async function markCompleted(run: Phase3ValidationRun): Promise<void> {
  if (run.status === 'completed') return;
  const now = new Date().toISOString();
  const db = await getDatabase();
  await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID },
    { $set: { status: 'completed', completedAt: now, updatedAt: now } },
  );
  await recordAuditEvent('phase3-validator', 'phase3.validation_completed', {
    startedAt: run.startedAt,
    completedAt: now,
    targetCandidates: run.targetCandidates,
  });
}

export async function reconcilePhase3Validation(settings: BotSettings): Promise<{
  active: boolean;
  transitionedToDraining: boolean;
  report: Phase3ValidationReport;
}> {
  const safety = phase3Safety(settings);
  if (!safety.safeToValidate) {
    return {
      active: false,
      transitionedToDraining: false,
      report: summarizePhase3Validation({ settings, run: await getRun(), candidates: [], profiles: [], assessments: [] }),
    };
  }

  const run = await ensureRun(settings);
  if (!run) {
    return {
      active: false,
      transitionedToDraining: false,
      report: summarizePhase3Validation({ settings, run: null, candidates: [], profiles: [], assessments: [] }),
    };
  }

  if (run.status === 'draining' && settings.runState === 'stopped') {
    await markCompleted(run);
  }

  const currentRun = (await getRun()) ?? run;
  const data = await loadRunData(currentRun);
  const report = summarizePhase3Validation({ settings, run: currentRun, ...data });
  if (!report.targetReached || ['draining', 'ready_for_review', 'completed'].includes(currentRun.status)) {
    return { active: currentRun.status !== 'completed', transitionedToDraining: false, report };
  }

  const now = new Date().toISOString();
  const db = await getDatabase();
  await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID },
    { $set: { status: 'draining', updatedAt: now } },
  );
  await patchSettings({ runState: 'draining' }, 'phase3-validator');
  await recordAuditEvent('phase3-validator', 'phase3.validation_target_reached', {
    candidateCount: report.metrics.candidateCount,
    shadowProfileCount: report.metrics.shadowProfileCount,
    targetCandidates: currentRun.targetCandidates,
  });
  return { active: true, transitionedToDraining: true, report };
}

export async function completePhase3ValidationRun(): Promise<void> {
  const run = await getRun();
  if (run) await markCompleted(run);
}
