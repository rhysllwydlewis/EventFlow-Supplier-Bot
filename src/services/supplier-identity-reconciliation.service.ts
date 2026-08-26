import { getDatabase } from '../lib/mongo.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import { shadowProfileSchema } from '../domain/shadow-profile.js';
import { setCandidateDedupDecision, setCandidateStatus } from '../repositories/candidate.repository.js';
import {
  claimStrongIdentityKeys,
  findPotentialIdentityMatches,
  removeSupplierIdentity,
  saveDedupAssessment,
  upsertSupplierIdentity,
  withSupplierIdentityLock,
} from '../repositories/supplier-identity.repository.js';
import { assessSupplierDuplicate, DEDUP_POLICY_VERSION, toSupplierIdentity } from './supplier-dedup.service.js';

let reconciliationPromise: Promise<{ processed: number; duplicates: number; probable: number }> | null = null;

async function assessAndIndexProfile(profile: ShadowProfile) {
  return withSupplierIdentityLock(profile.candidateId, async () => {
    const identity = toSupplierIdentity(profile);
    const matches = await findPotentialIdentityMatches(identity);
    let assessment = await saveDedupAssessment(assessSupplierDuplicate(profile, matches));
    await setCandidateDedupDecision(profile.candidateId, assessment);

    if (assessment.decision !== 'distinct') {
      await removeSupplierIdentity(profile.candidateId);
      return { assessment, identity, indexed: false as const };
    }

    const claim = await claimStrongIdentityKeys(identity);
    if (!claim.claimed) {
      assessment = await saveDedupAssessment({
        candidateId: profile.candidateId,
        decision: 'strong_duplicate',
        matchedCandidateId: claim.ownerCandidateId,
        score: 100,
        signals: ['concurrent_identity_key_conflict'],
        policyVersion: DEDUP_POLICY_VERSION,
        assessedAt: new Date().toISOString(),
      });
      await setCandidateDedupDecision(profile.candidateId, assessment);
      await removeSupplierIdentity(profile.candidateId);
      return { assessment, identity, indexed: false as const };
    }

    await upsertSupplierIdentity(identity);
    return { assessment, identity, indexed: true as const };
  });
}

async function runHistoricalReconciliation(): Promise<{ processed: number; duplicates: number; probable: number }> {
  const db = await getDatabase();
  const cursor = db.collection<{ id: string; discoveredAt?: string }>('candidates')
    .find({ dedupDecision: { $exists: false } })
    .sort({ discoveredAt: 1, id: 1 })
    .batchSize(250);
  let processed = 0;
  let duplicates = 0;
  let probable = 0;

  for await (const candidate of cursor) {
    const raw = await db.collection<ShadowProfile>('shadow_profiles').findOne({ candidateId: candidate.id });
    if (!raw) continue;
    const profile = shadowProfileSchema.parse(raw);
    const result = await assessAndIndexProfile(profile);
    processed += 1;

    if (result.assessment.decision === 'strong_duplicate') {
      duplicates += 1;
      await setCandidateStatus(profile.candidateId, 'duplicate');
    } else if (result.assessment.decision === 'probable_duplicate') {
      probable += 1;
      await setCandidateStatus(profile.candidateId, 'quarantined');
    }
  }
  return { processed, duplicates, probable };
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
  return assessAndIndexProfile(profile);
}
