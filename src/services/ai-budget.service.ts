import { getDatabase } from '../lib/mongo.js';

interface AiBudgetCounter {
  id: string;
  day: string;
  amountGbp: number;
  updatedAt: string;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function tryReserveDailyAiBudget(
  configuredHardLimitGbp: number,
  absoluteHardLimitGbp: number,
  reservationGbp: number,
): Promise<boolean> {
  const effectiveLimit = Math.max(0, Math.min(configuredHardLimitGbp, absoluteHardLimitGbp));
  const reservation = Math.max(0, reservationGbp);
  if (reservation <= 0 || reservation > effectiveLimit) {
    return false;
  }

  const day = utcDay();
  const id = `ai-budget:${day}`;
  const db = await getDatabase();
  const store = db.collection<AiBudgetCounter>('runtime_counters');
  await store.updateOne(
    { id },
    { $setOnInsert: { id, day, amountGbp: 0, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );

  const maximumBeforeClaim = Math.max(0, effectiveLimit - reservation);
  const claimed = await store.findOneAndUpdate(
    { id, amountGbp: { $lte: maximumBeforeClaim } },
    { $inc: { amountGbp: reservation }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' },
  );
  return claimed !== null;
}

export async function getTodayAiReservedGbp(): Promise<number> {
  const day = utcDay();
  const db = await getDatabase();
  const record = await db.collection<AiBudgetCounter>('runtime_counters').findOne({ id: `ai-budget:${day}` });
  return record?.amountGbp ?? 0;
}
