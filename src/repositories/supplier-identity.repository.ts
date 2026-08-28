import { MongoServerError, type Collection } from 'mongodb';
import { dedupAssessmentSchema, supplierIdentitySchema, type DedupAssessment, type SupplierIdentity } from '../domain/supplier-identity.js';
import { getDatabase } from '../lib/mongo.js';
import { withMongoLease } from '../lib/mongo-lease.js';

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

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function withSupplierIdentityLock<T>(ownerHint: string, task: () => Promise<T>): Promise<T> {
  return withMongoLease(
    {
      collectionName: 'supplier_identity_locks',
      // ownerHint is the candidateId being reconciled -- it must be the lock
      // key itself, not just a human-readable label passed alongside a
      // hardcoded 'global' key, or reconciliation of unrelated candidates
      // serializes through one lock document instead of running independently.
      leaseKey: ownerHint,
      ownerHint,
      leaseMs: 60_000,
      acquireTimeoutMs: 30_000,
    },
    task,
  );
}

export async function releaseStrongIdentityKeys(candidateId: string): Promise<number> {
  const db = await getDatabase();
  const result = await db.collection<SupplierIdentityKey>('supplier_identity_keys').deleteMany({ candidateId });
  return result.deletedCount;
}

export async function claimStrongIdentityKeys(identity: SupplierIdentity): Promise<{ claimed: true } | { claimed: false; ownerCandidateId: string }> {
  const db = await getDatabase();
  const store = db.collection<SupplierIdentityKey>('supplier_identity_keys');
  for (const key of strongIdentityKeys(identity)) {
    try {
      await store.updateOne(
        { key },
        { $setOnInsert: { key, candidateId: identity.candidateId, claimedAt: new Date().toISOString() } },
        { upsert: true },
      );
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }

    const owner = await store.findOne({ key });
    if (!owner) {
      throw new Error(`Identity key claim disappeared before verification: ${key}`);
    }
    if (owner.candidateId !== identity.candidateId) {
      await store.deleteMany({ candidateId: identity.candidateId });
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

export async function removeSupplierIdentity(candidateId: string): Promise<void> {
  const store = await identities();
  await Promise.all([
    store.deleteOne({ candidateId }),
    releaseStrongIdentityKeys(candidateId),
  ]);
}

export async function findPotentialIdentityMatches(identity: SupplierIdentity, limit = 50): Promise<SupplierIdentity[]> {
  const store = await identities();
  const clauses: Record<string, unknown>[] = [{ normalizedName: identity.normalizedName }];
  // Same-domain is the single highest-value dedup signal -- without it here,
  // this query relied entirely on claimStrongIdentityKeys (which does key on
  // domain) to catch a same-domain collision after the fact, with a less
  // accurate audit-trail label than a direct match would produce.
  if (identity.canonicalDomain) clauses.push({ canonicalDomain: identity.canonicalDomain });
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
