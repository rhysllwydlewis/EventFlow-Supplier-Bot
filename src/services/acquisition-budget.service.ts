import { createHash } from 'node:crypto';
import { getDatabase } from '../lib/mongo.js';

interface AcquisitionCounter {
  id: string;
  day: string;
  globalCount: number;
  campaignCounts: Record<string, number>;
  updatedAt: string;
}

export function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function campaignCounterKey(campaignId: string): string {
  return createHash('sha256').update(campaignId).digest('hex').slice(0, 24);
}

export async function tryClaimDailyAcquisitionSlot(
  campaignId: string,
  campaignHardLimit: number,
  globalHardLimit: number,
  day: string = currentUtcDay(),
): Promise<boolean> {
  const campaignLimit = Math.max(0, Math.floor(campaignHardLimit));
  const globalLimit = Math.max(0, Math.floor(globalHardLimit));
  if (campaignLimit === 0 || globalLimit === 0) {
    return false;
  }

  const id = `acquisition:${day}`;
  const campaignKey = campaignCounterKey(campaignId);
  const campaignPath = `campaignCounts.${campaignKey}`;
  const db = await getDatabase();
  const store = db.collection<AcquisitionCounter>('runtime_counters');

  await store.updateOne(
    { id },
    {
      $setOnInsert: {
        id,
        day,
        globalCount: 0,
        campaignCounts: {},
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
  await store.updateOne(
    { id, [campaignPath]: { $exists: false } },
    { $set: { [campaignPath]: 0, updatedAt: new Date().toISOString() } },
  );

  const claimed = await store.findOneAndUpdate(
    {
      id,
      globalCount: { $lt: globalLimit },
      [campaignPath]: { $lt: campaignLimit },
    },
    {
      $inc: {
        globalCount: 1,
        [campaignPath]: 1,
      },
      $set: { updatedAt: new Date().toISOString() },
    },
    { returnDocument: 'after' },
  );
  return claimed !== null;
}

// A slot is claimed before the domain-uniqueness race is actually resolved
// at the database level (see upsertDiscoveredCandidate's unique-index
// insert-then-detect-conflict pattern) -- when two concurrent discovery
// cycles both see a domain as not-yet-a-candidate, both claim a slot, but
// only one of them actually creates the candidate. The loser's claimed slot
// would otherwise sit wasted for the rest of the UTC day. Only ever causes
// under-acquisition relative to the ceiling, never an overrun, so this is
// an efficiency fix, not a safety one.
//
// Each counter is decremented only while it is still above zero, gated by
// the same findOneAndUpdate-with-$gt pattern the claim side uses to gate
// $lt -- a caller that releases the same slot twice (a retried release, or
// a bug) must not be able to push a counter negative, since a negative
// counter widens how much can be claimed before the ceiling's $lt check
// trips, defeating the ceiling it exists to enforce. The two counters are
// decremented independently rather than in one $inc so that one already
// being at zero (e.g. from a prior release) never blocks the other from
// releasing.
export async function releaseDailyAcquisitionSlot(campaignId: string, day: string = currentUtcDay()): Promise<void> {
  const id = `acquisition:${day}`;
  const campaignKey = campaignCounterKey(campaignId);
  const campaignPath = `campaignCounts.${campaignKey}`;
  const db = await getDatabase();
  const store = db.collection<AcquisitionCounter>('runtime_counters');
  const updatedAt = new Date().toISOString();
  await store.findOneAndUpdate(
    { id, globalCount: { $gt: 0 } },
    { $inc: { globalCount: -1 }, $set: { updatedAt } },
  );
  await store.findOneAndUpdate(
    { id, [campaignPath]: { $gt: 0 } },
    { $inc: { [campaignPath]: -1 }, $set: { updatedAt } },
  );
}
