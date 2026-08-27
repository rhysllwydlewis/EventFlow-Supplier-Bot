import { env } from '../config/env.js';
import { getCandidate } from '../repositories/candidate.repository.js';
import { getCampaign } from '../repositories/campaign.repository.js';
import {
  saveComplianceAssessment,
  withCompliancePolicyLock,
} from '../repositories/compliance-assessment.repository.js';
import { listCandidateEvidence } from '../repositories/evidence.repository.js';
import {
  getEventFlowIngestion,
  saveEventFlowIngestionState,
} from '../repositories/eventflow-ingestion.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { getShadowProfile } from '../repositories/shadow-profile.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import {
  assessShadowProfileCompliance,
  effectiveMinimumPublicationQuality,
} from './compliance.service.js';
import {
  ingestShadowProfileToEventFlow,
  PUBLIC_UNCLAIMED_SCOPE,
} from './eventflow-ingestion.service.js';

function integrationConfigured(): boolean {
  return Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET);
}

function retryAt(attempt: number): string {
  const delayMs = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
  return new Date(Date.now() + delayMs).toISOString();
}

function publicationControlBlockReason(settings: {
  mode: string;
  runState: string;
  publishingEnabled: boolean;
}): string | null {
  if (settings.runState !== 'running') {
    return settings.runState === 'emergency_stopped'
      ? 'emergency_stopped'
      : `run_state_${settings.runState}`;
  }
  if (settings.mode !== 'live') return 'mode_not_live';
  if (!settings.publishingEnabled) return 'publishing_disabled';
  return null;
}

export async function processEventFlowPublication(candidateId: string): Promise<Record<string, unknown>> {
  const [profile, candidate] = await Promise.all([
    getShadowProfile(candidateId),
    getCandidate(candidateId),
  ]);

  if (!profile || !candidate) {
    await saveEventFlowIngestionState({
      candidateId,
      status: 'ineligible',
      reason: 'missing_shadow_profile_or_candidate',
    });
    return { skipped: true, reason: 'missing_shadow_profile_or_candidate' };
  }

  if (await isSuppressed(candidate.canonicalDomain, 'do_not_list')) {
    await saveEventFlowIngestionState({
      candidateId,
      status: 'ineligible',
      reason: 'do_not_list_suppression',
    });
    return { skipped: true, reason: 'do_not_list_suppression' };
  }

  if (candidate.dedupDecision !== 'distinct') {
    const reason = candidate.dedupDecision
      ? `identity_${candidate.dedupDecision}`
      : 'identity_dedup_not_ready';
    await saveEventFlowIngestionState({
      candidateId,
      status: candidate.dedupDecision ? 'ineligible' : 'pending',
      reason,
    });
    return { skipped: true, reason };
  }

  return withCompliancePolicyLock(`eventflow-publication:${candidateId}`, async () => {
    const settings = await getSettings();
    const controlBlockReason = publicationControlBlockReason(settings);
    if (controlBlockReason) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'pending',
        reason: controlBlockReason,
      });
      return { skipped: true, reason: 'publishing_not_authorized' };
    }
    if (!integrationConfigured()) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'pending',
        reason: 'eventflow_integration_not_configured',
      });
      return { skipped: true, reason: 'eventflow_integration_not_configured' };
    }

    const [campaign, evidence] = await Promise.all([
      getCampaign(candidate.campaignId),
      listCandidateEvidence(candidateId),
    ]);
    const minimumPublicationQuality = effectiveMinimumPublicationQuality(
      settings.minimumPublicationQuality,
      campaign?.minimumPublicationQuality,
    );
    const compliance = await saveComplianceAssessment(assessShadowProfileCompliance({
      profile,
      evidence,
      minimumPublicationQuality,
    }));

    if (!compliance.publicationEligible) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'ineligible',
        reason: `compliance_${compliance.status}`,
      });
      return { skipped: true, reason: 'compliance_not_publication_eligible' };
    }

    const liveSettings = await getSettings();
    const liveControlBlockReason = publicationControlBlockReason(liveSettings);
    if (liveControlBlockReason) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'pending',
        reason: liveControlBlockReason,
      });
      return { skipped: true, reason: 'publishing_revoked_before_send' };
    }

    // Suppression is rechecked immediately before the external write so a
    // do-not-list decision made while compliance was being assessed wins the race.
    if (await isSuppressed(candidate.canonicalDomain, 'do_not_list')) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'ineligible',
        reason: 'do_not_list_suppression',
      });
      return { skipped: true, reason: 'do_not_list_suppression' };
    }

    const result = await ingestShadowProfileToEventFlow({
      profile,
      compliance,
      publishingEnabled: true,
      publicationScope: PUBLIC_UNCLAIMED_SCOPE,
    });

    if (result.status === 'created' || result.status === 'existing') {
      if (!result.publicProfilePath) {
        await saveEventFlowIngestionState({
          candidateId,
          status: 'failed',
          supplierId: result.supplierId,
          slug: result.slug,
          reason: 'eventflow_public_profile_path_missing',
          incrementAttempts: true,
          nextRetryAt: retryAt(1),
        });
        throw new Error('EventFlow publication succeeded without a public profile path');
      }
      await saveEventFlowIngestionState({
        candidateId,
        status: result.status,
        supplierId: result.supplierId,
        slug: result.slug,
        publicProfilePath: result.publicProfilePath,
      });
      return result;
    }
    if (result.status === 'conflict' || result.status === 'ineligible') {
      await saveEventFlowIngestionState({
        candidateId,
        status: result.status,
        reason: result.reason,
      });
      return result;
    }
    if (result.status === 'disabled' || result.status === 'not_configured') {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'pending',
        reason: result.reason,
      });
      return result;
    }
    if (result.status !== 'failed') {
      throw new Error(`Unexpected EventFlow ingestion result: ${result.status}`);
    }

    const previous = await getEventFlowIngestion(candidateId);
    const nextAttempt = (previous?.attempts ?? 0) + 1;
    await saveEventFlowIngestionState({
      candidateId,
      status: 'failed',
      reason: result.reason,
      incrementAttempts: true,
      nextRetryAt: retryAt(nextAttempt),
    });
    throw new Error(`EventFlow publication failed: ${result.reason}`);
  });
}
