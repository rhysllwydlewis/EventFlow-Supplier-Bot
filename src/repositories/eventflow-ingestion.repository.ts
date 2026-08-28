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
  const set: Partial<EventFlowIngestionRecord> = {
    status: input.status,
    supplierId: input.supplierId ?? null,
    slug: input.slug ?? null,
    publicProfilePath: input.publicProfilePath ?? null,
    reason: input.reason ?? null,
    nextRetryAt: input.nextRetryAt ?? null,
    updatedAt: now,
  };
  // $setOnInsert only ever applies on a genuine insert, never on an update
  // to an existing document -- so putting attempts:0 there (as this used to)
  // meant an existing record's attempts count was left untouched by every
  // non-incrementing save, not reset. A candidate that cycles through e.g.
  // ineligible -> pending (a fresh crawl) -> ineligible again would keep
  // accumulating attempts across unrelated episodes, backing off faster
  // each time even though each occurrence is really a fresh one. Every
  // non-incrementing status (pending, created, existing, conflict) is
  // conceptually the start of a new episode, so reset the count in $set
  // instead, where it actually takes effect on both insert and update.
  if (!input.incrementAttempts) set.attempts = 0;

  const update: UpdateFilter<EventFlowIngestionRecord> = {
    $set: set,
    $setOnInsert: { candidateId: input.candidateId, createdAt: now },
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
              // 'ineligible' means "compliance/dedup/suppression refused this
              // at the time it was last attempted" -- not "never retry
              // again". It is re-derived fresh on every
              // processEventFlowPublication run, so retrying it is
              // self-correcting: a candidate that failed compliance once and
              // was later reassessed as eligible (e.g. an operator lowering
              // minimumPublicationQuality, which wipes and re-scores every
              // compliance_assessments record via
              // invalidateAllComplianceAssessments -- see
              // compliance-reassessment.service.ts) would otherwise show
              // "Ready" in Shadow review forever, because reassessment never
              // touches this collection and nothing else ever re-queues it.
              // Backed off on the same exponential nextRetryAt schedule as
              // 'failed' (markIneligible, eventflow-publication.service.ts)
              // so a *structurally* ineligible candidate (a known
              // non-supplier domain, an active suppression) doesn't
              // re-qualify for retry on literally every 5-minute reconcile
              // cycle forever.
              { 'ingestion.status': { $in: ['failed', 'ineligible'] } },
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

// A 'created'/'existing' status means EventFlow already confirmed this
// candidate is live -- written directly and unconditionally by
// processEventFlowPublication (via saveEventFlowIngestionState), unlike
// published_suppliers.recordPublishedSupplier, which is a best-effort write
// that can silently fail without ever blocking the publish it's recording.
// This is the most reliable source for reconciling published_suppliers when
// the two have drifted apart, since it's keyed by candidateId (no need for
// the shadow profile's website to be looked up via an old audit trail that
// may not have carried it) -- see published-supplier-backfill.service.ts.
export async function listCreatedOrExistingEventFlowIngestions(limit = 500): Promise<EventFlowIngestionRecord[]> {
  const store = await collection();
  return store
    .find({ status: { $in: ['created', 'existing'] } })
    .sort({ updatedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
}
