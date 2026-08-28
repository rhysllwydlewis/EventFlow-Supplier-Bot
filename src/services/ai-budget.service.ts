import { getDatabase } from '../lib/mongo.js';

interface AiBudgetCounter {
  id: string;
  day: string;
  amountGbp: number;
  updatedAt: string;
}

export function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// The caller supplies `day` (defaulting to today) rather than this function
// recomputing "today" independently each time -- a reservation made just
// before UTC midnight and released just after would otherwise decrement a
// different day's counter than the one it actually incremented. Capturing
// the day once at reservation time and threading it through to the matching
// release call keeps them pointed at the same document.
export async function tryReserveDailyAiBudget(
  configuredHardLimitGbp: number,
  absoluteHardLimitGbp: number,
  reservationGbp: number,
  day: string = currentUtcDay(),
): Promise<boolean> {
  const effectiveLimit = Math.max(0, Math.min(configuredHardLimitGbp, absoluteHardLimitGbp));
  const reservation = Math.max(0, reservationGbp);
  if (reservation <= 0 || reservation > effectiveLimit) {
    return false;
  }

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

// A reservation is claimed before the OpenAI call is made (so a burst of
// concurrent calls can't jointly exceed the daily cap) but is only ever
// meant to cover the cost of a *successful* call -- without a release path,
// every failed call still permanently eats its reservation, so the budget
// ledger drifts further from the actual-cost ledger over time even though
// no money was spent. Bounded impact (each call's reservation caps the
// loss), but real drift, so failed calls release what they reserved.
export async function releaseDailyAiBudget(reservationGbp: number, day: string = currentUtcDay()): Promise<void> {
  const reservation = Math.max(0, reservationGbp);
  if (reservation <= 0) return;
  const id = `ai-budget:${day}`;
  const db = await getDatabase();
  const store = db.collection<AiBudgetCounter>('runtime_counters');
  await store.updateOne(
    { id },
    { $inc: { amountGbp: -reservation }, $set: { updatedAt: new Date().toISOString() } },
  );
}

export async function getTodayAiReservedGbp(): Promise<number> {
  const day = currentUtcDay();
  const db = await getDatabase();
  const record = await db.collection<AiBudgetCounter>('runtime_counters').findOne({ id: `ai-budget:${day}` });
  return record?.amountGbp ?? 0;
}
