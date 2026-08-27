import type { BotSettings } from '../domain/settings.js';
import { getQueue } from '../queues/index.js';
import {
  getCandidateByCanonicalDomain,
  setCandidateStatus,
} from '../repositories/candidate.repository.js';
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
const PILOT_REFRESH_RETRY_AFTER_MS = 5 * 60_000;
const EVENTFLOW_ORIGIN = 'https://event-flow.co.uk';

function pilotRunBlockReason(settings: BotSettings): string | null {
  if (settings.mode === 'off') return 'bot_off';
  if (settings.runState !== 'running') return `run_state_${settings.runState}`;
  return null;
}

function refreshIsStale(state: EventFlowPilotState): boolean {
  const updatedAt = Date.parse(state.updatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= PILOT_REFRESH_RETRY_AFTER_MS;
}

function profileIsNewerThanRefresh(profileGeneratedAt: string, refreshQueuedAt: string): boolean {
  const generatedAt = Date.parse(profileGeneratedAt);
  const queuedAt = Date.parse(refreshQueuedAt);
  return Number.isFinite(generatedAt) && Number.isFinite(queuedAt) && generatedAt > queuedAt;
}

async function queuePilotRefresh(input: {
  candidateId: string;
  businessName: string;
  reason: 'current_pipeline_refresh_queued' | 'current_pipeline_refresh_requeued';
}): Promise<EventFlowPilotState> {
  await setCandidateStatus(input.candidateId, 'queued_for_crawl');
  const retryBucket = Math.floor(Date.now() / PILOT_REFRESH_RETRY_AFTER_MS);
  await getQueue('crawl').add(
    'crawl-candidate',
    { candidateId: input.candidateId, trigger: 'one-profile-production-pilot' },
    {
      jobId: `one-profile-pilot-refresh-${input.candidateId}-${retryBucket}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
  return saveEventFlowPilotState({
    status: 'refreshing',
    candidateId: input.candidateId,
    businessName: input.businessName,
    reason: input.reason,
  });
}

export function pilotPublicProfileUrl(state: EventFlowPilotState | null): string | null {
  if (!state?.publicProfilePath || state.status !== 'published') return null;
  try {
    const url = new URL(state.publicProfilePath, EVENTFLOW_ORIGIN);
    if (url.origin !== EVENTFLOW_ORIGIN || !url.pathname.startsWith('/supplier/')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function runOneProfileEventFlowPilot(): Promise<EventFlowPilotState> {
  const previous = await getEventFlowPilotState();
  if (previous?.status === 'published' && previous.publicProfilePath) return previous;

  const settings = await getSettings();
  const runBlockReason = pilotRunBlockReason(settings);
  if (runBlockReason) {
    return saveEventFlowPilotState({ status: 'waiting', reason: runBlockReason });
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
  // pipeline once after the pilot is introduced. The bucketed job id prevents
  // concurrent reconcilers from fanning out duplicate refresh work.
  if (!previous || previous.candidateId !== candidate.id) {
    return queuePilotRefresh({
      candidateId: candidate.id,
      businessName: profile?.businessName ?? 'Hensol Castle',
      reason: 'current_pipeline_refresh_queued',
    });
  }

  if (
    !profile ||
    (previous.status === 'refreshing' &&
      !profileIsNewerThanRefresh(profile.generatedAt, previous.updatedAt))
  ) {
    if (previous.status === 'refreshing' && refreshIsStale(previous)) {
      return queuePilotRefresh({
        candidateId: candidate.id,
        businessName: profile?.businessName ?? previous.businessName ?? 'Hensol Castle',
        reason: 'current_pipeline_refresh_requeued',
      });
    }
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

  // Re-read operator controls and candidate identity immediately before the
  // only external write. A pause/stop, emergency stop, dedupe change or a new
  // do-not-list suppression must win over this deliberately scoped bypass.
  const liveSettings = await getSettings();
  const liveRunBlockReason = pilotRunBlockReason(liveSettings);
  if (liveRunBlockReason) {
    return saveEventFlowPilotState({
      status: 'waiting',
      candidateId: candidate.id,
      businessName: profile.businessName,
      reason: `${liveRunBlockReason}_before_send`,
    });
  }

  const liveCandidate = await getCandidateByCanonicalDomain(PILOT_DOMAIN);
  if (!liveCandidate || liveCandidate.id !== candidate.id || liveCandidate.dedupDecision !== 'distinct') {
    return saveEventFlowPilotState({
      status: 'waiting',
      candidateId: candidate.id,
      businessName: profile.businessName,
      reason: 'identity_changed_before_send',
    });
  }
  if (await isSuppressed(liveCandidate.canonicalDomain, 'do_not_list')) {
    return saveEventFlowPilotState({
      status: 'failed',
      candidateId: candidate.id,
      businessName: profile.businessName,
      reason: 'do_not_list_suppression',
    });
  }

  const result = await ingestShadowProfileToEventFlow({
    profile,
    compliance,
    publishingEnabled: true,
    publicationScope: PILOT_PUBLICATION_SCOPE,
  });

  switch (result.status) {
    case 'created':
    case 'existing':
      if (!result.publicProfilePath) {
        return saveEventFlowPilotState({
          status: 'waiting',
          candidateId: candidate.id,
          businessName: profile.businessName,
          supplierId: result.supplierId,
          slug: result.slug,
          reason: 'eventflow_public_profile_path_missing',
        });
      }
      return saveEventFlowPilotState({
        status: 'published',
        candidateId: candidate.id,
        businessName: profile.businessName,
        supplierId: result.supplierId,
        slug: result.slug,
        publicProfilePath: result.publicProfilePath,
        reason: null,
        publishedAt: previous?.publishedAt ?? new Date().toISOString(),
      });
    case 'failed':
    case 'disabled':
    case 'not_configured':
      return saveEventFlowPilotState({
        status: 'waiting',
        candidateId: candidate.id,
        businessName: profile.businessName,
        reason: result.reason,
      });
    case 'conflict':
    case 'ineligible':
      return saveEventFlowPilotState({
        status: 'failed',
        candidateId: candidate.id,
        businessName: profile.businessName,
        reason: result.reason,
      });
  }
}
