import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import { getDatabase } from '../lib/mongo.js';
import { getCampaign } from '../repositories/campaign.repository.js';
import { getCandidate } from '../repositories/candidate.repository.js';
import {
  listPendingComplianceCandidateIds,
  saveComplianceAssessment,
  withCompliancePolicyLock,
} from '../repositories/compliance-assessment.repository.js';
import { listCandidateEvidence } from '../repositories/evidence.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import {
  assessShadowProfileCompliance,
  effectiveMinimumPublicationQuality,
} from './compliance.service.js';
import { reconcilePhase3Validation } from './phase3-validation.service.js';

export async function reassessPendingCompliance(limit = 100): Promise<number> {
  const ids = await listPendingComplianceCandidateIds(limit);
  const db = await getDatabase();
  let reassessed = 0;

  for (const candidateId of ids) {
    const completed = await withCompliancePolicyLock(`reassess:${candidateId}`, async () => {
      const [settings, rawProfile, candidate, evidence] = await Promise.all([
        getSettings(),
        db.collection<ShadowProfile>('shadow_profiles').findOne({ candidateId }),
        getCandidate(candidateId),
        listCandidateEvidence(candidateId),
      ]);
      if (!rawProfile || !candidate) return false;
      const profile = shadowProfileSchema.parse(rawProfile);
      const campaign = await getCampaign(candidate.campaignId);
      const minimumPublicationQuality = effectiveMinimumPublicationQuality(
        settings.minimumPublicationQuality,
        campaign?.minimumPublicationQuality,
      );
      await saveComplianceAssessment(assessShadowProfileCompliance({
        profile,
        evidence,
        minimumPublicationQuality,
      }));
      return true;
    });
    if (completed) reassessed += 1;
  }

  // Phase 3 is deliberately piggy-backed on the existing five-minute system
  // reconciliation cycle. This keeps validation autonomous without adding a
  // second scheduler or weakening any production safety control. The validator
  // only activates while the bot is in Shadow mode with publishing, marketing,
  // claim notices and SEO indexing all disabled.
  const settings = await getSettings();
  await reconcilePhase3Validation(settings);

  return reassessed;
}
