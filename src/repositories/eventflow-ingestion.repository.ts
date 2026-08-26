import type { Collection, UpdateFilter } from 'mongodb';
import { getDatabase } from '../lib/mongo.js';

export type EventFlowIngestionStatus =
  | 'pending'
  | 'created'
  | 'existing'
  | 'conflict'
  | 'failed'
  | 'ineligible';

export interface EventFlowIngestionRecord {
  candidateId: string;
  status: EventFlowIngestionStatus;
  supplierId?: string | null;
  slug?: string | null;
  reason?: string | null;
  attempts: number;
  nextRetryAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

async function collection(): Promise<Collection<EventFlowIngestionRecord>> {
  const db = await getDatabase();
  return db.collection<EventFlowIngestionRecord>('eventflow_ingestions');
}

export async function getEventFlowIngestion(candidateId: string): Promise<EventFlowIngestionRecord | null> {
  const store = await collection();
  return store.findOne({ candidateId });
}

export async function saveEventFlowIngestionState(input: {
  candidateId: string;
  status: EventFlowIngestionStatus;
  supplierId?: string | null;
  slug?: string | null;
  reason?: string | null;
  incrementAttempts?: boolean;
  nextRetryAt?: string | null;
}): Promise<void> {
  const store = await collection();
  const now = new Date().toISOString();
  const setOnInsert: Partial<EventFlowIngestionRecord> = {
    candidateId: input.candidateId,
    createdAt: now,
  };
  if (!input.incrementAttempts) setOnInsert.attempts = 0;

  const update: UpdateFilter<EventFlowIngestionRecord> = {
    $set: {
      status: input.status,
      supplierId: input.supplierId ?? null,
      slug: input.slug ?? null,
      reason: input.reason ?? null,
      nextRetryAt: input.nextRetryAt ?? null,
      updatedAt: now,
    },
    $setOnInsert: setOnInsert,
  };
  if (input.incrementAttempts) update.$inc = { attempts: 1 };
  await store.updateOne({ candidateId: input.candidateId }, update, { upsert: true });
}

export async function listRetryableEventFlowCandidateIds(limit = 100): Promise<string[]> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const rows = await db.collection('shadow_profiles').aggregate<{ candidateId: string }>([
    {
      $lookup: {
        from: 'eventflow_ingestions',
        localField: 'candidateId',
        foreignField: 'candidateId',
        as: 'ingestions',
      },
    },
    { $set: { ingestion: { $arrayElemAt: ['$ingestions', 0] } } },
    {
      $match: {
        $or: [
          { ingestion: null },
          { 'ingestion.status': 'pending' },
          {
            $and: [
              { 'ingestion.status': 'failed' },
              {
                $or: [
                  { 'ingestion.nextRetryAt': null },
                  { 'ingestion.nextRetryAt': { $lte: now } },
                ],
              },
            ],
          },
        ],
      },
    },
    { $sort: { generatedAt: 1 } },
    { $limit: Math.min(Math.max(limit, 1), 500) },
    { $project: { _id: 0, candidateId: 1 } },
  ]).toArray();
  return rows.map(row => row.candidateId).filter(Boolean);
}
