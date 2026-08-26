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
import { ingestShadowProfileToEventFlow } from './eventflow-ingestion.service.js';

function integrationConfigured(): boolean {
  return Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET);
}

function retryAt(attempt: number): string {
  const delayMs = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
  return new Date(Date.now() + delayMs).toISOString();
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
    if (settings.runState === 'emergency_stopped' || !settings.publishingEnabled) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'pending',
        reason: settings.runState === 'emergency_stopped' ? 'emergency_stopped' : 'publishing_disabled',
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
    if (liveSettings.runState === 'emergency_stopped' || !liveSettings.publishingEnabled) {
      await saveEventFlowIngestionState({
        candidateId,
        status: 'pending',
        reason: liveSettings.runState === 'emergency_stopped' ? 'emergency_stopped' : 'publishing_disabled',
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
    });

    if (result.status === 'created' || result.status === 'existing') {
      await saveEventFlowIngestionState({
        candidateId,
        status: result.status,
        supplierId: result.supplierId,
        slug: result.slug,
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
