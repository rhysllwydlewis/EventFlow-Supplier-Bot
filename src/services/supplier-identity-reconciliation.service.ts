import { getDatabase } from '../lib/mongo.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import { shadowProfileSchema } from '../domain/shadow-profile.js';
import { setCandidateDedupDecision, setCandidateStatus } from '../repositories/candidate.repository.js';
import {
  claimStrongIdentityKeys,
  findPotentialIdentityMatches,
  saveDedupAssessment,
  upsertSupplierIdentity,
} from '../repositories/supplier-identity.repository.js';
import { assessSupplierDuplicate, DEDUP_POLICY_VERSION, toSupplierIdentity } from './supplier-dedup.service.js';

let reconciliationPromise: Promise<{ processed: number; duplicates: number; probable: number }> | null = null;

async function claimDistinctIdentity(profile: ShadowProfile) {
  const identity = toSupplierIdentity(profile);
  const claim = await claimStrongIdentityKeys(identity);
  if (!claim.claimed) {
    const assessment = await saveDedupAssessment({
      candidateId: profile.candidateId,
      decision: 'strong_duplicate',
      matchedCandidateId: claim.ownerCandidateId,
      score: 100,
      signals: ['concurrent_identity_key_conflict'],
      policyVersion: DEDUP_POLICY_VERSION,
      assessedAt: new Date().toISOString(),
    });
    await setCandidateDedupDecision(profile.candidateId, assessment);
    return { assessment, identity, indexed: false as const };
  }
  await upsertSupplierIdentity(identity);
  return { identity, indexed: true as const };
}

async function runHistoricalReconciliation(): Promise<{ processed: number; duplicates: number; probable: number }> {
  const db = await getDatabase();
  const records = await db.collection<ShadowProfile>('shadow_profiles').find({}).sort({ generatedAt: 1 }).limit(5000).toArray();
  let duplicates = 0;
  let probable = 0;

  for (const raw of records) {
    const profile = shadowProfileSchema.parse(raw);
    const identity = toSupplierIdentity(profile);
    const matches = await findPotentialIdentityMatches(identity);
    let assessment = await saveDedupAssessment(assessSupplierDuplicate(profile, matches));
    await setCandidateDedupDecision(profile.candidateId, assessment);

    if (assessment.decision === 'strong_duplicate') {
      duplicates += 1;
      await setCandidateStatus(profile.candidateId, 'duplicate');
      continue;
    }
    if (assessment.decision === 'probable_duplicate') {
      probable += 1;
      await setCandidateStatus(profile.candidateId, 'quarantined');
      continue;
    }

    const claimed = await claimDistinctIdentity(profile);
    if (!claimed.indexed) {
      assessment = claimed.assessment;
      duplicates += 1;
      await setCandidateStatus(profile.candidateId, 'duplicate');
    }
  }
  return { processed: records.length, duplicates, probable };
}

export async function ensureHistoricalIdentityReconciliation() {
  if (!reconciliationPromise) {
    reconciliationPromise = runHistoricalReconciliation().catch(error => {
      reconciliationPromise = null;
      throw error;
    });
  }
  return reconciliationPromise;
}

export async function assessAndPersistSupplierDuplicate(profile: ShadowProfile) {
  await ensureHistoricalIdentityReconciliation();
  const identity = toSupplierIdentity(profile);
  const matches = await findPotentialIdentityMatches(identity);
  let assessment = await saveDedupAssessment(assessSupplierDuplicate(profile, matches));
  await setCandidateDedupDecision(profile.candidateId, assessment);

  if (assessment.decision !== 'distinct') return { assessment, identity, indexed: false as const };

  const claimed = await claimDistinctIdentity(profile);
  if (!claimed.indexed) {
    assessment = claimed.assessment;
    return { assessment, identity, indexed: false as const };
  }
  return { assessment, identity, indexed: true as const };
}
