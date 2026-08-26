import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { candidateSchema, type Candidate } from '../domain/candidate.js';
import { canonicalDomain, canonicalizePublicHttpUrl } from '../utils/url.js';
import { getDatabase } from '../lib/mongo.js';

async function collection(): Promise<Collection<Candidate>> {
  const db = await getDatabase();
  return db.collection<Candidate>('candidates');
}

export async function upsertDiscoveredCandidate(input: {
  campaignId: string;
  provider: string;
  discoveryQuery: string;
  sourceUrl: string;
  titleHint?: string;
  snippetHint?: string;
  categoryHint?: string;
  locationHint?: string;
}): Promise<{ candidate: Candidate; created: boolean }> {
  const url = canonicalizePublicHttpUrl(input.sourceUrl);
  const domain = canonicalDomain(url.href);
  const store = await collection();
  const existing = await store.findOne({ canonicalDomain: domain });
  if (existing) {
    return { candidate: candidateSchema.parse(existing), created: false };
  }

  const now = new Date().toISOString();
  const candidate = candidateSchema.parse({
    id: `candidate_${randomUUID()}`,
    campaignId: input.campaignId,
    provider: input.provider,
    discoveryQuery: input.discoveryQuery,
    sourceUrl: input.sourceUrl,
    canonicalUrl: url.href,
    canonicalDomain: domain,
    titleHint: input.titleHint ?? null,
    snippetHint: input.snippetHint ?? null,
    categoryHint: input.categoryHint ?? null,
    locationHint: input.locationHint ?? null,
    status: 'discovered',
    discoveredAt: now,
    updatedAt: now,
  });

  try {
    await store.insertOne(candidate);
    return { candidate, created: true };
  } catch (error) {
    const duplicate = await store.findOne({ canonicalDomain: domain });
    if (duplicate) {
      return { candidate: candidateSchema.parse(duplicate), created: false };
    }
    throw error;
  }
}

export async function getCandidate(id: string): Promise<Candidate | null> {
  const store = await collection();
  const record = await store.findOne({ id });
  return record ? candidateSchema.parse(record) : null;
}

export async function listCandidates(limit = 100): Promise<Candidate[]> {
  const store = await collection();
  const records = await store
    .find({})
    .sort({ updatedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
  return records.map(record => candidateSchema.parse(record));
}

export async function listCandidatesByStatus(status: Candidate['status'], limit = 250): Promise<Candidate[]> {
  const store = await collection();
  const records = await store
    .find({ status })
    .sort({ updatedAt: 1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
  return records.map(record => candidateSchema.parse(record));
}

export async function countCandidatesSince(isoTimestamp: string): Promise<number> {
  const store = await collection();
  return store.countDocuments({ discoveredAt: { $gte: isoTimestamp } });
}

export async function countCampaignCandidatesSince(campaignId: string, isoTimestamp: string): Promise<number> {
  const store = await collection();
  return store.countDocuments({ campaignId, discoveredAt: { $gte: isoTimestamp } });
}

export async function setCandidateStatus(id: string, status: Candidate['status']): Promise<void> {
  const store = await collection();
  await store.updateOne({ id }, { $set: { status, updatedAt: new Date().toISOString() } });
}
