import type { Collection } from 'mongodb';
import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import { getDatabase } from '../lib/mongo.js';

async function collection(): Promise<Collection<ShadowProfile>> {
  const db = await getDatabase();
  return db.collection<ShadowProfile>('shadow_profiles');
}

export async function saveShadowProfile(profile: ShadowProfile): Promise<ShadowProfile> {
  const validated = shadowProfileSchema.parse(profile);
  const store = await collection();
  await store.replaceOne({ candidateId: validated.candidateId }, validated, { upsert: true });
  return validated;
}

export async function getShadowProfile(candidateId: string): Promise<ShadowProfile | null> {
  const store = await collection();
  const record = await store.findOne({ candidateId });
  return record ? shadowProfileSchema.parse(record) : null;
}

export async function listShadowProfiles(limit = 100): Promise<ShadowProfile[]> {
  const store = await collection();
  const records = await store.find({}).sort({ generatedAt: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray();
  return records.map(record => shadowProfileSchema.parse(record));
}

export async function getShadowProfilesForCandidateIds(candidateIds: string[]): Promise<ShadowProfile[]> {
  const ids = [...new Set(candidateIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return [];
  const store = await collection();
  const records = await store.find({ candidateId: { $in: ids } }).toArray();
  return records.map(record => shadowProfileSchema.parse(record));
}

export async function deleteShadowProfile(candidateId: string): Promise<boolean> {
  const store = await collection();
  const result = await store.deleteOne({ candidateId });
  return result.deletedCount > 0;
}
