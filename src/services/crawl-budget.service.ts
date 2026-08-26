import { getDatabase } from '../lib/mongo.js';

interface CrawlCounter {
  id: string;
  day: string;
  count: number;
  updatedAt: string;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function tryClaimDailyCrawlSlot(configuredLimit: number, absoluteLimit: number): Promise<boolean> {
  const effectiveLimit = Math.max(0, Math.min(Math.floor(configuredLimit), Math.floor(absoluteLimit)));
  if (effectiveLimit === 0) {
    return false;
  }

  const day = utcDay();
  const id = `crawl:${day}`;
  const db = await getDatabase();
  const store = db.collection<CrawlCounter>('runtime_counters');
  await store.updateOne(
    { id },
    { $setOnInsert: { id, day, count: 0, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );

  const claimed = await store.findOneAndUpdate(
    { id, count: { $lt: effectiveLimit } },
    { $inc: { count: 1 }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' },
  );
  return claimed !== null;
}

export async function getTodayCrawlCount(): Promise<number> {
  const day = utcDay();
  const db = await getDatabase();
  const record = await db.collection<CrawlCounter>('runtime_counters').findOne({ id: `crawl:${day}` });
  return record?.count ?? 0;
}
