import { getDatabase } from '../lib/mongo.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import { shadowProfileSchema } from '../domain/shadow-profile.js';
import { setCandidateDedupDecision, setCandidateStatus } from '../repositories/candidate.repository.js';
import {
  findPotentialIdentityMatches,
  saveDedupAssessment,
  upsertSupplierIdentity,
} from '../repositories/supplier-identity.repository.js';
import { assessSupplierDuplicate, toSupplierIdentity } from './supplier-dedup.service.js';

let reconciliationPromise: Promise<{ processed: number; duplicates: number; probable: number }> | null = null;

async function runHistoricalReconciliation(): Promise<{ processed: number; duplicates: number; probable: number }> {
  const db = await getDatabase();
  const records = await db.collection<ShadowProfile>('shadow_profiles')
    .find({})
    .sort({ generatedAt: 1 })
    .limit(5000)
    .toArray();

  let duplicates = 0;
  let probable = 0;
  for (const raw of records) {
    const profile = shadowProfileSchema.parse(raw);
    const identity = toSupplierIdentity(profile);
    const matches = await findPotentialIdentityMatches(identity);
    const assessment = await saveDedupAssessment(assessSupplierDuplicate(profile, matches));
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
    await upsertSupplierIdentity(identity);
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
  const assessment = await saveDedupAssessment(assessSupplierDuplicate(profile, matches));
  await setCandidateDedupDecision(profile.candidateId, assessment);
  return { assessment, identity };
}
