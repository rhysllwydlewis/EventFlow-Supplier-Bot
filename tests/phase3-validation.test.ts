import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/domain/candidate.js';
import type { ComplianceAssessment } from '../src/domain/compliance-assessment.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import { defaultSettings } from '../src/domain/settings.js';
import {
  PHASE3_TARGET_CANDIDATES,
  phase3Safety,
  summarizePhase3Validation,
  type Phase3ValidationRun,
} from '../src/services/phase3-validation.service.js';

const workerSource = readFileSync(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
const phase3Source = readFileSync(
  new URL('../src/services/phase3-validation.service.ts', import.meta.url),
  'utf8',
);

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    campaignId: 'cmp_phase3',
    provider: 'brave',
    discoveryQuery: 'wedding venues south wales',
    sourceUrl: `https://${id}.example.com`,
    canonicalUrl: `https://${id}.example.com/`,
    canonicalDomain: `${id}.example.com`,
    titleHint: 'Venue',
    snippetHint: 'Venue in South Wales',
    categoryHint: 'Venues',
    locationHint: 'South Wales',
    status: 'shadow_ready',
    dedupDecision: 'distinct',
    discoveredAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function profile(id: string, overrides: Partial<ShadowProfile> = {}): ShadowProfile {
  return {
    candidateId: id,
    businessName: `Venue ${id}`,
    category: 'Venues',
    location: 'Cardiff',
    website: `https://${id}.example.com/`,
    description: 'A real venue profile built from retained website evidence.',
    publicEmail: `hello@${id}.example.com`,
    publicPhone: '029 2000 0000',
    advertisedPrices: ['From £1,000'],
    services: ['Wedding venue'],
    packages: [{ name: 'Venue hire', price: '£1,000', features: ['Exclusive use'] }],
    evidenceIds: [`ev_${id}`],
    coverImage: `https://${id}.example.com/hero.jpg`,
    images: [`https://${id}.example.com/hero.jpg`, `https://${id}.example.com/gallery.jpg`],
    mediaEvidence: [],
    dataConfidence: 90,
    publicationQuality: 92,
    generatedAt: '2026-08-27T00:10:00.000Z',
    generatorVersion: 'test',
    ...overrides,
  };
}

function assessment(id: string, overrides: Partial<ComplianceAssessment> = {}): ComplianceAssessment {
  return {
    candidateId: id,
    policyVersion: 'phase3-test',
    status: 'pass',
    publicationEligible: true,
    seoIndexEligible: false,
    descriptionSimilarity: 0,
    reasons: [],
    fallbacks: [],
    mediaStrategy: 'eventflow_category_fallback',
    logoStrategy: 'initials_tile',
    assessedAt: '2026-08-27T00:20:00.000Z',
    ...overrides,
  };
}

const run: Phase3ValidationRun = {
  id: 'phase3-shadow-validation',
  status: 'collecting',
  startedAt: '2026-08-27T00:00:00.000Z',
  completedAt: null,
  campaignId: 'cmp_phase3',
  targetCandidates: PHASE3_TARGET_CANDIDATES,
  restartRequiredAt: null,
  restartReason: null,
  updatedAt: '2026-08-27T00:00:00.000Z',
};

describe('Phase 3 shadow validation', () => {
  it('requires every outbound control to remain off in Shadow mode', () => {
    const settings = defaultSettings();
    expect(phase3Safety(settings)).toEqual({
      shadowMode: true,
      publishingOff: true,
      marketingOff: true,
      claimNoticesOff: true,
      seoIndexingOff: true,
      safeToValidate: true,
    });

    expect(phase3Safety({ ...settings, publishingEnabled: true }).safeToValidate).toBe(false);
    expect(phase3Safety({ ...settings, mode: 'live' }).safeToValidate).toBe(false);
  });

  it('summarises quality, evidence, media, extraction, dedup and compliance signals', () => {
    const settings = defaultSettings();
    const candidates = [
      candidate('a'),
      candidate('b', { dedupDecision: 'probable_duplicate' }),
      candidate('c', { dedupDecision: 'strong_duplicate', status: 'rejected' }),
      candidate('d', { status: 'quarantined' }),
    ];
    const profiles = [
      profile('a'),
      profile('b', { publicPhone: null, packages: [], advertisedPrices: [], images: [], coverImage: null }),
      profile('d', { publicEmail: null, evidenceIds: [], publicationQuality: 70, dataConfidence: 80, images: ['https://d.example.com/hero.jpg'], coverImage: 'https://d.example.com/hero.jpg' }),
    ];
    const assessments = [
      assessment('a', { seoIndexEligible: true }),
      assessment('b', { status: 'review', publicationEligible: false }),
      assessment('d', { status: 'block', publicationEligible: false }),
    ];

    const report = summarizePhase3Validation({
      settings,
      run,
      candidates,
      profiles,
      assessments,
      aiEstimatedCostGbp: 2,
    });

    expect(report.targetReached).toBe(false);
    expect(report.metrics.candidateCount).toBe(4);
    expect(report.metrics.shadowProfileCount).toBe(3);
    expect(report.metrics.profileYieldPct).toBe(75);
    expect(report.metrics.averagePublicationQuality).toBe(84.7);
    expect(report.metrics.averageDataConfidence).toBe(86.7);
    expect(report.metrics.evidenceCoveragePct).toBe(66.7);
    expect(report.metrics.imageCoveragePct).toBe(66.7);
    expect(report.metrics.averageImagesPerProfile).toBe(1);
    expect(report.metrics.publicEmailCoveragePct).toBe(66.7);
    expect(report.metrics.publicPhoneCoveragePct).toBe(66.7);
    expect(report.metrics.advertisedPriceCoveragePct).toBe(66.7);
    expect(report.metrics.packageCoveragePct).toBe(66.7);
    expect(report.metrics.distinctCandidates).toBe(2);
    expect(report.metrics.probableDuplicates).toBe(1);
    expect(report.metrics.strongDuplicates).toBe(1);
    expect(report.metrics.quarantinedCandidates).toBe(1);
    expect(report.metrics.rejectedCandidates).toBe(1);
    expect(report.metrics.publicationEligible).toBe(1);
    expect(report.metrics.complianceReview).toBe(1);
    expect(report.metrics.complianceBlocked).toBe(2);
    expect(report.metrics.seoReady).toBe(1);
    expect(report.metrics.aiEstimatedCostGbp).toBe(2);
    expect(report.metrics.aiCostPerCandidateGbp).toBe(0.5);
  });

  it('does not call the 100-candidate sample review-ready until the drain has finalised it', () => {
    const settings = defaultSettings();
    const candidates = Array.from({ length: PHASE3_TARGET_CANDIDATES }, (_, index) =>
      candidate(`c${index}`),
    );
    const profiles = candidates.map(item => profile(item.id));
    const assessments = candidates.map(item => assessment(item.id));

    const collectingReport = summarizePhase3Validation({ settings, run, candidates, profiles, assessments });
    expect(collectingReport.targetReached).toBe(true);
    expect(collectingReport.readyForReview).toBe(false);

    const completedReport = summarizePhase3Validation({
      settings,
      run: { ...run, status: 'completed', completedAt: '2026-08-28T00:00:00.000Z' },
      candidates,
      profiles,
      assessments,
    });
    expect(completedReport.readyForReview).toBe(true);
    expect(completedReport.metrics.profileYieldPct).toBe(100);
    expect(completedReport.metrics.imageCoveragePct).toBe(100);
  });

  it('is wired into the production reconciler and completes after a safe drain', () => {
    expect(workerSource).toContain('reconcilePhase3Validation(initialSettings)');
    expect(workerSource).toContain('phase3.transitionedToDraining ? await getSettings() : initialSettings');
    expect(workerSource).toContain("settings.runState === 'draining'");
    expect(workerSource).toContain('await completePhase3ValidationRun()');
    expect(workerSource.indexOf('await completePhase3ValidationRun()')).toBeGreaterThan(workerSource.indexOf('if (await pipelineIsDrained())'));
  });

  it('binds a new validation run to a running South Wales venue campaign only', () => {
    expect(phase3Source).toContain("campaign.status !== 'running'");
    expect(phase3Source).toContain("categories.includes('venues')");
    expect(phase3Source).toContain("locations.includes('south wales')");
    expect(phase3Source).toContain('const campaignId = await resolvePhase3CampaignId(settings)');
    expect(phase3Source).toContain('if (!campaignId) return null');
    expect(phase3Source).toContain('candidateFilter.campaignId = run.campaignId');
  });

  it('refuses to schedule Shadow discovery until the validation ledger is initialized', () => {
    expect(workerSource).toContain('const phase3 = await reconcilePhase3Validation(initialSettings)');
    expect(workerSource).toContain("reason: 'phase3_validation_not_initialized'");
    expect(workerSource).toContain('phase3.report.run?.campaignId !== campaign.id');
    expect(workerSource.indexOf('const phase3 = await reconcilePhase3Validation(initialSettings)')).toBeLessThan(workerSource.indexOf("getQueue('discovery').add"));
  });

  it('freezes completed metrics and attributes AI spend to sampled candidates only', () => {
    expect(phase3Source).toContain('if (run.completedAt) discoveredAt.$lte = run.completedAt');
    expect(phase3Source).toContain("collection<StoredAiExtraction>('ai_extractions')");
    expect(phase3Source).toContain("find({ candidateId: { $in: ids } })");
    expect(phase3Source).not.toContain("collection<{ day: string; estimatedCostGbp?: number }>('ai_usage')");
  });

  it('invalidates and fail-closes an active sample if any safety toggle breaks', () => {
    expect(phase3Source).toContain("restartReason: 'safety_contract_broken'");
    expect(phase3Source).toContain("runState: 'emergency_stopped'");
    expect(phase3Source).toContain("mode: 'shadow'");
    expect(phase3Source).toContain('publishingEnabled: false');
    expect(phase3Source).toContain('claimNoticesEnabled: false');
    expect(phase3Source).toContain('marketingEnabled: false');
    expect(phase3Source).toContain('seoIndexingEnabled: false');
    expect(phase3Source).toContain('phase3.validation_restarted');
  });
});