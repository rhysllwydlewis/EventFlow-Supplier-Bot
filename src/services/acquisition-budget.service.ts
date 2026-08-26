import { createHash } from 'node:crypto';
import { getDatabase } from '../lib/mongo.js';

interface AcquisitionCounter {
  id: string;
  day: string;
  globalCount: number;
  campaignCounts: Record<string, number>;
  updatedAt: string;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function campaignCounterKey(campaignId: string): string {
  return createHash('sha256').update(campaignId).digest('hex').slice(0, 24);
}

export async function tryClaimDailyAcquisitionSlot(
  campaignId: string,
  campaignHardLimit: number,
  globalHardLimit: number,
): Promise<boolean> {
  const campaignLimit = Math.max(0, Math.floor(campaignHardLimit));
  const globalLimit = Math.max(0, Math.floor(globalHardLimit));
  if (campaignLimit === 0 || globalLimit === 0) {
    return false;
  }

  const day = utcDay();
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
