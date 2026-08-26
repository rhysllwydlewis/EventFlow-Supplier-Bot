import type { Collection } from 'mongodb';
import { dedupAssessmentSchema, supplierIdentitySchema, type DedupAssessment, type SupplierIdentity } from '../domain/supplier-identity.js';
import { getDatabase } from '../lib/mongo.js';

async function identities(): Promise<Collection<SupplierIdentity>> {
  const db = await getDatabase();
  return db.collection<SupplierIdentity>('supplier_identities');
}

async function assessments(): Promise<Collection<DedupAssessment>> {
  const db = await getDatabase();
  return db.collection<DedupAssessment>('dedup_assessments');
}

export async function upsertSupplierIdentity(identity: SupplierIdentity): Promise<SupplierIdentity> {
  const validated = supplierIdentitySchema.parse(identity);
  const store = await identities();
  await store.replaceOne({ candidateId: validated.candidateId }, validated, { upsert: true });
  return validated;
}

export async function findPotentialIdentityMatches(identity: SupplierIdentity, limit = 50): Promise<SupplierIdentity[]> {
  const store = await identities();
  const clauses: Record<string, unknown>[] = [
    { normalizedName: identity.normalizedName },
  ];
  if (identity.normalizedEmail) clauses.push({ normalizedEmail: identity.normalizedEmail });
  if (identity.normalizedPhone) clauses.push({ normalizedPhone: identity.normalizedPhone });
  if (identity.normalizedLocation) clauses.push({ normalizedLocation: identity.normalizedLocation, normalizedName: identity.normalizedName });

  const records = await store.find({ candidateId: { $ne: identity.candidateId }, $or: clauses })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
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
