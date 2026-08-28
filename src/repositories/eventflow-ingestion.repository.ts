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
  publicProfilePath?: string | null;
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

export async function getEventFlowIngestionsForCandidates(
  candidateIds: string[],
): Promise<EventFlowIngestionRecord[]> {
  const ids = [...new Set(candidateIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const store = await collection();
  return store.find({ candidateId: { $in: ids } }).toArray();
}

export async function saveEventFlowIngestionState(input: {
  candidateId: string;
  status: EventFlowIngestionStatus;
  supplierId?: string | null;
  slug?: string | null;
  publicProfilePath?: string | null;
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
      publicProfilePath: input.publicProfilePath ?? null,
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
          // 'ineligible' means "compliance/dedup/suppression refused this at
          // the time it was last attempted" -- not "never retry again". It is
          // re-derived fresh on every processEventFlowPublication run, so
          // retrying it is cheap and self-correcting: a candidate that is
          // still genuinely blocked (known non-supplier domain, do-not-list)
          // just gets marked 'ineligible' again for near-zero cost. Without
          // this, a candidate that failed compliance once and was later
          // reassessed as eligible (e.g. an operator lowering
          // minimumPublicationQuality, which wipes and re-scores every
          // compliance_assessments record via
          // invalidateAllComplianceAssessments -- see
          // compliance-reassessment.service.ts) shows "Ready" in Shadow
          // review forever, because reassessment never touches this
          // collection and nothing else ever re-queues it for publication.
          { 'ingestion.status': 'ineligible' },
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

// A 'conflict' status means EventFlow itself rejected the publish attempt
// because a supplier with that website already exists -- most often a real,
// independently-registered business the bot separately discovered and
// crawled. This is resolved, not pending: it will never become publishable
// by waiting, so it must not be retried (listRetryableEventFlowCandidateIds
// above deliberately excludes it) and must not sit looking actionable in
// Shadow review forever either.
export async function listConflictedEventFlowIngestions(limit = 100): Promise<EventFlowIngestionRecord[]> {
  const store = await collection();
  return store
    .find({ status: 'conflict' })
    .sort({ updatedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
}
