import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import { getDatabase } from '../lib/mongo.js';
import { getCampaign } from '../repositories/campaign.repository.js';
import { getCandidate } from '../repositories/candidate.repository.js';
import {
  listPendingComplianceCandidateIds,
  saveComplianceAssessment,
} from '../repositories/compliance-assessment.repository.js';
import { listCandidateEvidence } from '../repositories/evidence.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import {
  assessShadowProfileCompliance,
  effectiveMinimumPublicationQuality,
} from './compliance.service.js';

export async function reassessPendingCompliance(limit = 100): Promise<number> {
  const ids = await listPendingComplianceCandidateIds(limit);
  if (ids.length === 0) return 0;

  const settings = await getSettings();
  const db = await getDatabase();
  let reassessed = 0;
  for (const candidateId of ids) {
    const [rawProfile, candidate, evidence] = await Promise.all([
      db.collection<ShadowProfile>('shadow_profiles').findOne({ candidateId }),
      getCandidate(candidateId),
      listCandidateEvidence(candidateId),
    ]);
    if (!rawProfile || !candidate) continue;
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
    reassessed += 1;
  }
  return reassessed;
}
