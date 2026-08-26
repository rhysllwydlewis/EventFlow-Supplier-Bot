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

export async function listShadowProfiles(limit = 100): Promise<ShadowProfile[]> {
  const store = await collection();
  const records = await store.find({}).sort({ generatedAt: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray();
  return records.map(record => shadowProfileSchema.parse(record));
}
