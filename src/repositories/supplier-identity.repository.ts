import type { Collection } from 'mongodb';
import { dedupAssessmentSchema, supplierIdentitySchema, type DedupAssessment, type SupplierIdentity } from '../domain/supplier-identity.js';
import { getDatabase } from '../lib/mongo.js';

interface SupplierIdentityKey {
  key: string;
  candidateId: string;
  claimedAt: string;
}

async function identities(): Promise<Collection<SupplierIdentity>> {
  const db = await getDatabase();
  return db.collection<SupplierIdentity>('supplier_identities');
}

async function assessments(): Promise<Collection<DedupAssessment>> {
  const db = await getDatabase();
  return db.collection<DedupAssessment>('dedup_assessments');
}

function strongIdentityKeys(identity: SupplierIdentity): string[] {
  const keys = [`domain:${identity.canonicalDomain}`];
  if (identity.normalizedName && identity.normalizedEmail) keys.push(`name_email:${identity.normalizedName}|${identity.normalizedEmail}`);
  if (identity.normalizedName && identity.normalizedPhone) keys.push(`name_phone:${identity.normalizedName}|${identity.normalizedPhone}`);
  if (identity.normalizedEmail && identity.normalizedPhone && identity.normalizedLocation) {
    keys.push(`email_phone_location:${identity.normalizedEmail}|${identity.normalizedPhone}|${identity.normalizedLocation}`);
  }
  return [...new Set(keys)];
}

export async function claimStrongIdentityKeys(identity: SupplierIdentity): Promise<{ claimed: true } | { claimed: false; ownerCandidateId: string }> {
  const db = await getDatabase();
  const store = db.collection<SupplierIdentityKey>('supplier_identity_keys');
  const inserted: string[] = [];
  for (const key of strongIdentityKeys(identity)) {
    try {
      const result = await store.updateOne(
        { key },
        { $setOnInsert: { key, candidateId: identity.candidateId, claimedAt: new Date().toISOString() } },
        { upsert: true },
      );
      if (result.upsertedCount === 1) inserted.push(key);
    } catch {
      // A concurrent unique-key insert can race the upsert query. Read the winner below.
    }
    const owner = await store.findOne({ key });
    if (owner && owner.candidateId !== identity.candidateId) {
      if (inserted.length) await store.deleteMany({ candidateId: identity.candidateId, key: { $in: inserted } });
      return { claimed: false, ownerCandidateId: owner.candidateId };
    }
  }
  return { claimed: true };
}

export async function upsertSupplierIdentity(identity: SupplierIdentity): Promise<SupplierIdentity> {
  const validated = supplierIdentitySchema.parse(identity);
  const store = await identities();
  await store.replaceOne({ candidateId: validated.candidateId }, validated, { upsert: true });
  return validated;
}

export async function findPotentialIdentityMatches(identity: SupplierIdentity, limit = 50): Promise<SupplierIdentity[]> {
  const store = await identities();
  const clauses: Record<string, unknown>[] = [{ normalizedName: identity.normalizedName }];
  if (identity.normalizedEmail) clauses.push({ normalizedEmail: identity.normalizedEmail });
  if (identity.normalizedPhone) clauses.push({ normalizedPhone: identity.normalizedPhone });
  if (identity.normalizedLocation) clauses.push({ normalizedLocation: identity.normalizedLocation, normalizedName: identity.normalizedName });
  const records = await store.find({ candidateId: { $ne: identity.candidateId }, $or: clauses }).limit(Math.min(Math.max(limit, 1), 200)).toArray();
  return records.map(record => supplierIdentitySchema.parse(record));
}

export async function saveDedupAssessment(assessment: DedupAssessment): Promise<DedupAssessment> {
  const validated = dedupAssessmentSchema.parse(assessment);
  const store = await assessments();
  await store.replaceOne({ candidateId: validated.candidateId }, validated, { upsert: true });
  return validated;
}

export async function listDedupAssessments(limit = 100): Promise<DedupAssessment[]> {
  const store = await assessments();
  const records = await store.find({}).sort({ assessedAt: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray();
  return records.map(record => dedupAssessmentSchema.parse(record));
}
