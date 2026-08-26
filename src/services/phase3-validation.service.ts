import type { Filter } from 'mongodb';
import type { Candidate } from '../domain/candidate.js';
import type { ComplianceAssessment } from '../domain/compliance-assessment.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import type { BotSettings } from '../domain/settings.js';
import { getDatabase } from '../lib/mongo.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import type { StoredAiExtraction } from '../repositories/ai-extraction.repository.js';
import { getCampaign, listCampaigns } from '../repositories/campaign.repository.js';
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
  restartRequiredAt?: string | null;
  restartReason?: string | null;
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

function isSouthWalesVenueCampaign(campaign: {
  status: string;
  categories: string[];
  locations: string[];
} | null): boolean {
  if (!campaign || campaign.status !== 'running') return false;
  const categories = campaign.categories.map(value => value.trim().toLowerCase());
  const locations = campaign.locations.map(value => value.trim().toLowerCase());
  return categories.includes('venues') && locations.includes('south wales');
}

async function resolvePhase3CampaignId(settings: BotSettings): Promise<string | null> {
  if (settings.activeCampaignId) {
    const active = await getCampaign(settings.activeCampaignId);
    return isSouthWalesVenueCampaign(active) ? active!.id : null;
  }

  const running = (await listCampaigns())
    .filter(isSouthWalesVenueCampaign)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return running[0]?.id ?? null;
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
    // Identity duplicate decisions are terminal policy outcomes even when the
    // pipeline intentionally never writes a Shadow profile for that candidate.
    if (candidate.dedupDecision === 'strong_duplicate') {
      complianceBlocked += 1;
      continue;
    }
    if (candidate.dedupDecision === 'probable_duplicate') {
      complianceReview += 1;
      continue;
    }

    if (!profileIds.has(candidate.id)) continue;
    const assessment = assessmentByCandidate.get(candidate.id);
    if (!assessment) continue;
    if (candidate.dedupDecision === 'distinct' && assessment.publicationEligible) publicationEligible += 1;
    if (assessment.status === 'review') complianceReview += 1;
    else if (assessment.status === 'block') complianceBlocked += 1;
    if (candidate.dedupDecision === 'distinct' && assessment.seoIndexEligible) seoReady += 1;
  }

  const aiEstimatedCostGbp = Math.max(0, Number(input.aiEstimatedCostGbp) || 0);
  const target = input.run?.targetCandidates ?? PHASE3_TARGET_CANDIDATES;
  const targetReached = candidateCount >= target;
  const finalised = Boolean(input.run && input.run.status === 'completed');

  return {
    run: input.run,
    safety: phase3Safety(input.settings),
    targetReached,
    readyForReview: targetReached && profileCount > 0 && finalised,
    metrics: {
      candidateCount,
      shadowProfileCount: profileCount,
      profileYieldPct: pct(profileCount, candidateCount),
      averagePublicationQuality: average(profiles.map(item => item.publicationQuality)),
      averageDataConfidence: average(profiles.map(item => item.dataConfidence)),
      evidenceCoveragePct: pct(profiles.filter(item => item.evidenceIds.length > 0).length, profileCount),
      publicEmailCoveragePct: pct(profiles.filter(item => isPopulated(item.publicEmail)).length, profileCount),
      publicPhoneCoveragePct: pct(profiles.filter(item => isPopulated(item.publicPhone)).length, profileCount),
      advertisedPriceCoveragePct: pct(
        profiles.filter(item => item.advertisedPrices.length > 0).length,
        profileCount,
      ),
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
      aiCostPerCandidateGbp:
        candidateCount > 0 ? round(aiEstimatedCostGbp / candidateCount, 4) : 0,
    },
  };
}

async function getRun(): Promise<Phase3ValidationRun | null> {
  const db = await getDatabase();
  const record = await db
    .collection<Phase3ValidationRun>('validation_runs')
    .findOne({ id: PHASE3_VALIDATION_ID });
  return record ? { ...record, id: PHASE3_VALIDATION_ID } : null;
}

async function restartInvalidatedRun(
  run: Phase3ValidationRun,
  settings: BotSettings,
): Promise<Phase3ValidationRun> {
  if (!run.restartRequiredAt || settings.runState !== 'running') return run;
  const campaignId = await resolvePhase3CampaignId(settings);
  if (!campaignId) return run;

  const now = new Date().toISOString();
  const updates = {
    status: 'collecting' as const,
    startedAt: now,
    completedAt: null,
    campaignId,
    restartRequiredAt: null,
    restartReason: null,
    updatedAt: now,
  };
  const db = await getDatabase();
  await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID },
    { $set: updates },
  );
  await recordAuditEvent('phase3-validator', 'phase3.validation_restarted', {
    previousStartedAt: run.startedAt,
    invalidatedAt: run.restartRequiredAt,
    campaignId,
    targetCandidates: run.targetCandidates,
  });
  return { ...run, ...updates };
}

async function ensureRun(settings: BotSettings): Promise<Phase3ValidationRun | null> {
  const existing = await getRun();
  if (existing) return restartInvalidatedRun(existing, settings);
  if (settings.runState !== 'running') return null;

  const campaignId = await resolvePhase3CampaignId(settings);
  if (!campaignId) return null;

  const now = new Date().toISOString();
  const run: Phase3ValidationRun = {
    id: PHASE3_VALIDATION_ID,
    status: 'collecting',
    startedAt: now,
    completedAt: null,
    campaignId,
    targetCandidates: PHASE3_TARGET_CANDIDATES,
    restartRequiredAt: null,
    restartReason: null,
    updatedAt: now,
  };
  const db = await getDatabase();
  const result = await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID },
    { $setOnInsert: run },
    { upsert: true },
  );
  if (result.upsertedCount > 0) {
    await recordAuditEvent('phase3-validator', 'phase3.validation_started', {
      targetCandidates: PHASE3_TARGET_CANDIDATES,
      campaignId,
    });
  }
  return (await getRun()) ?? run;
}

async function loadRunData(run: Phase3ValidationRun) {
  if (run.restartRequiredAt) {
    return { candidates: [], profiles: [], assessments: [], aiEstimatedCostGbp: 0 };
  }

  const db = await getDatabase();
  const discoveredAt: { $gte: string; $lte?: string } = { $gte: run.startedAt };
  if (run.completedAt) discoveredAt.$lte = run.completedAt;
  const candidateFilter: Filter<Candidate> = { discoveredAt };
  if (run.campaignId) candidateFilter.campaignId = run.campaignId;

  const candidates = await db
    .collection<Candidate>('candidates')
    .find(candidateFilter)
    .sort({ discoveredAt: 1 })
    .limit(250)
    .toArray();
  const ids = candidates.map(item => item.id);
  const [profiles, assessments, aiExtractions] = await Promise.all([
    ids.length > 0
      ? db.collection<ShadowProfile>('shadow_profiles').find({ candidateId: { $in: ids } }).toArray()
      : Promise.resolve([]),
    ids.length > 0
      ? db
          .collection<ComplianceAssessment>('compliance_assessments')
          .find({ candidateId: { $in: ids } })
          .toArray()
      : Promise.resolve([]),
    ids.length > 0
      ? db
          .collection<StoredAiExtraction>('ai_extractions')
          .find({ candidateId: { $in: ids } })
          .project<Pick<StoredAiExtraction, 'estimatedCostGbp'>>({ _id: 0, estimatedCostGbp: 1 })
          .toArray()
      : Promise.resolve([]),
  ]);

  return {
    candidates,
    profiles,
    assessments,
    aiEstimatedCostGbp: aiExtractions.reduce(
      (sum, item) => sum + Math.max(0, Number(item.estimatedCostGbp) || 0),
      0,
    ),
  };
}

export async function getPhase3ValidationReport(
  settings: BotSettings,
): Promise<Phase3ValidationReport> {
  const run = await getRun();
  if (!run) {
    return summarizePhase3Validation({
      settings,
      run: null,
      candidates: [],
      profiles: [],
      assessments: [],
    });
  }
  const data = await loadRunData(run);
  return summarizePhase3Validation({ settings, run, ...data });
}

async function invalidateUnsafeRun(
  run: Phase3ValidationRun,
  settings: BotSettings,
): Promise<Phase3ValidationRun> {
  if (run.status === 'completed' || run.restartRequiredAt) return run;
  const now = new Date().toISOString();
  const updates = {
    restartRequiredAt: now,
    restartReason: 'safety_contract_broken',
    updatedAt: now,
  };
  const db = await getDatabase();
  await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID },
    { $set: updates },
  );

  await patchSettings(
    {
      mode: 'shadow',
      runState: 'emergency_stopped',
      publishingEnabled: false,
      claimNoticesEnabled: false,
      marketingEnabled: false,
      seoIndexingEnabled: false,
    },
    'phase3-validator-fail-closed',
  );
  await recordAuditEvent('phase3-validator', 'phase3.validation_invalidated', {
    startedAt: run.startedAt,
    invalidatedAt: now,
    reason: 'safety_contract_broken',
    observedSettings: {
      mode: settings.mode,
      publishingEnabled: settings.publishingEnabled,
      claimNoticesEnabled: settings.claimNoticesEnabled,
      marketingEnabled: settings.marketingEnabled,
      seoIndexingEnabled: settings.seoIndexingEnabled,
    },
  });
  return { ...run, ...updates };
}

async function markCompleted(run: Phase3ValidationRun): Promise<boolean> {
  if (run.status === 'completed') return true;
  if (run.status !== 'draining' || run.restartRequiredAt) return false;

  const data = await loadRunData(run);
  if (data.candidates.length < run.targetCandidates) return false;

  const now = new Date().toISOString();
  const db = await getDatabase();
  const result = await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID, status: 'draining', restartRequiredAt: null },
    { $set: { status: 'completed', completedAt: now, updatedAt: now } },
  );
  if (result.modifiedCount === 0) return false;
  await recordAuditEvent('phase3-validator', 'phase3.validation_completed', {
    startedAt: run.startedAt,
    completedAt: now,
    targetCandidates: run.targetCandidates,
    candidateCount: data.candidates.length,
    shadowProfileCount: data.profiles.length,
    aiEstimatedCostGbp: data.aiEstimatedCostGbp,
  });
  return true;
}

export async function reconcilePhase3Validation(settings: BotSettings): Promise<{
  active: boolean;
  transitionedToDraining: boolean;
  report: Phase3ValidationReport;
}> {
  const safety = phase3Safety(settings);
  if (!safety.safeToValidate) {
    const existing = await getRun();
    const run = existing ? await invalidateUnsafeRun(existing, settings) : existing;
    const data = run
      ? await loadRunData(run)
      : { candidates: [], profiles: [], assessments: [], aiEstimatedCostGbp: 0 };
    return {
      active: false,
      transitionedToDraining: false,
      report: summarizePhase3Validation({ settings, run, ...data }),
    };
  }

  const run = await ensureRun(settings);
  if (!run) {
    return {
      active: false,
      transitionedToDraining: false,
      report: summarizePhase3Validation({
        settings,
        run: null,
        candidates: [],
        profiles: [],
        assessments: [],
      }),
    };
  }

  if (run.restartRequiredAt) {
    return {
      active: false,
      transitionedToDraining: false,
      report: summarizePhase3Validation({
        settings,
        run,
        candidates: [],
        profiles: [],
        assessments: [],
      }),
    };
  }

  if (run.status === 'draining' && settings.runState === 'stopped') {
    await markCompleted(run);
  }

  const currentRun = (await getRun()) ?? run;
  const data = await loadRunData(currentRun);
  const report = summarizePhase3Validation({ settings, run: currentRun, ...data });
  if (
    !report.targetReached ||
    ['draining', 'ready_for_review', 'completed'].includes(currentRun.status)
  ) {
    return {
      active: currentRun.status !== 'completed',
      transitionedToDraining: false,
      report,
    };
  }

  const now = new Date().toISOString();
  const db = await getDatabase();
  const result = await db.collection<Phase3ValidationRun>('validation_runs').updateOne(
    { id: PHASE3_VALIDATION_ID, status: 'collecting', restartRequiredAt: null },
    { $set: { status: 'draining', updatedAt: now } },
  );
  if (result.modifiedCount === 0) {
    const refreshed = (await getRun()) ?? currentRun;
    const refreshedData = await loadRunData(refreshed);
    return {
      active: refreshed.status !== 'completed',
      transitionedToDraining: false,
      report: summarizePhase3Validation({ settings, run: refreshed, ...refreshedData }),
    };
  }

  await patchSettings({ runState: 'draining' }, 'phase3-validator');
  await recordAuditEvent('phase3-validator', 'phase3.validation_target_reached', {
    candidateCount: report.metrics.candidateCount,
    shadowProfileCount: report.metrics.shadowProfileCount,
    targetCandidates: currentRun.targetCandidates,
  });
  return { active: true, transitionedToDraining: true, report };
}

export async function completePhase3ValidationRun(): Promise<boolean> {
  const run = await getRun();
  return run ? markCompleted(run) : false;
}
