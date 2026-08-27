import { createHash } from 'node:crypto';
import { getQueue } from '../queues/index.js';
import { getCandidateByCanonicalDomain, setCandidateStatus } from '../repositories/candidate.repository.js';
import { getComplianceAssessmentsForCandidates } from '../repositories/compliance-assessment.repository.js';
import {
  getEventFlowPilotState,
  saveEventFlowPilotState,
  type EventFlowPilotState,
} from '../repositories/eventflow-pilot.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { getShadowProfile } from '../repositories/shadow-profile.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import { ingestShadowProfileToEventFlow } from './eventflow-ingestion.service.js';

const PILOT_DOMAIN = 'hensolcastle.com';
const PILOT_PUBLICATION_SCOPE = 'pilot_unclaimed' as const;
const MIN_PILOT_QUALITY = 80;
const MIN_PILOT_CONFIDENCE = 70;

function publicSlug(name: string, supplierId: string): string {
  const namePart = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'supplier';
  const token = createHash('sha256').update(supplierId).digest('hex').slice(0, 16);
  return `${namePart}--${token}`;
}

export function pilotPublicProfileUrl(state: EventFlowPilotState | null): string | null {
  if (!state?.supplierId || !state.businessName || state.status !== 'published') return null;
  return `https://event-flow.co.uk/supplier/${publicSlug(state.businessName, state.supplierId)}`;
}

export async function runOneProfileEventFlowPilot(): Promise<EventFlowPilotState> {
  const previous = await getEventFlowPilotState();
  if (previous?.status === 'published') return previous;

  const settings = await getSettings();
  if (settings.runState === 'emergency_stopped' || settings.mode === 'off') {
    return saveEventFlowPilotState({
      status: 'waiting',
      reason: settings.runState === 'emergency_stopped' ? 'emergency_stopped' : 'bot_off',
    });
  }

  const candidate = await getCandidateByCanonicalDomain(PILOT_DOMAIN);
  if (!candidate) {
    return saveEventFlowPilotState({ status: 'waiting', reason: 'pilot_candidate_not_found' });
  }
  if (await isSuppressed(candidate.canonicalDomain, 'do_not_list')) {
    return saveEventFlowPilotState({
      status: 'failed',
      candidateId: candidate.id,
      reason: 'do_not_list_suppression',
    });
  }
  if (candidate.dedupDecision !== 'distinct') {
    return saveEventFlowPilotState({
      status: 'waiting',
      candidateId: candidate.id,
      reason: 'identity_dedup_not_ready',
    });
  }

  const profile = await getShadowProfile(candidate.id);

  // Always run this one supplier through the current crawler/extractor/media
  // pipeline once after the pilot is introduced. The dedicated job id avoids
  // the normal same-day crawl-job dedupe, while the worker's normal crawl
  // budget and emergency-stop checks still apply.
  if (!previous || previous.candidateId !== candidate.id) {
    await setCandidateStatus(candidate.id, 'queued_for_crawl');
    await getQueue('crawl').add(
      'crawl-candidate',
      { candidateId: candidate.id, trigger: 'one-profile-production-pilot' },
      {
        jobId: `one-profile-pilot-refresh-${candidate.id}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
    return saveEventFlowPilotState({
      status: 'refreshing',
      candidateId: candidate.id,
      businessName: profile?.businessName ?? 'Hensol Castle',
      reason: 'current_pipeline_refresh_queued',
    });
  }

  if (!profile || (previous.status === 'refreshing' && Date.parse(profile.generatedAt) <= Date.parse(previous.updatedAt))) {
    return previous;
  }

  const hasMedia = Boolean(profile.coverImage || profile.images.length > 0);
  if (!hasMedia) {
    return saveEventFlowPilotState({
      status: 'failed',
      candidateId: candidate.id,
      businessName: profile.businessName,
      reason: 'no_supplier_media_found_after_refresh',
    });
  }
  if (
    profile.publicationQuality < MIN_PILOT_QUALITY ||
    profile.dataConfidence < MIN_PILOT_CONFIDENCE ||
    profile.evidenceIds.length === 0
  ) {
    return saveEventFlowPilotState({
      status: 'failed',
      candidateId: candidate.id,
      businessName: profile.businessName,
      reason: 'pilot_profile_quality_below_threshold',
    });
  }

  const assessments = await getComplianceAssessmentsForCandidates([candidate.id]);
  const compliance = assessments[0];
  if (!compliance?.publicationEligible) {
    return saveEventFlowPilotState({
      status: 'waiting',
      candidateId: candidate.id,
      businessName: profile.businessName,
      reason: compliance ? `compliance_${compliance.status}` : 'compliance_not_ready',
    });
  }

  await saveEventFlowPilotState({
    status: 'publishing',
    candidateId: candidate.id,
    businessName: profile.businessName,
    reason: null,
  });

  const result = await ingestShadowProfileToEventFlow({
    profile,
    compliance,
    publishingEnabled: true,
    publicationScope: PILOT_PUBLICATION_SCOPE,
  });

  if (result.status === 'created' || result.status === 'existing') {
    return saveEventFlowPilotState({
      status: 'published',
      candidateId: candidate.id,
      businessName: profile.businessName,
      supplierId: result.supplierId,
      slug: result.slug,
      reason: null,
      publishedAt: new Date().toISOString(),
    });
  }

  return saveEventFlowPilotState({
    status: result.status === 'failed' ? 'waiting' : 'failed',
    candidateId: candidate.id,
    businessName: profile.businessName,
    reason: result.reason,
  });
}
