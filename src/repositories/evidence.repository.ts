import type { Collection } from 'mongodb';
import type { EvidenceFragment } from '../evidence/evidence.js';
import { getDatabase } from '../lib/mongo.js';

async function collection(): Promise<Collection<EvidenceFragment>> {
  const db = await getDatabase();
  return db.collection<EvidenceFragment>('evidence_fragments');
}

export async function saveEvidenceFragments(fragments: EvidenceFragment[]): Promise<void> {
  if (fragments.length === 0) return;
  const store = await collection();
  await store.insertMany(fragments, { ordered: false });
}

export async function listCandidateEvidence(candidateId: string): Promise<EvidenceFragment[]> {
  const store = await collection();
  return store.find({ candidateId }).sort({ observedAt: 1 }).toArray();
}
