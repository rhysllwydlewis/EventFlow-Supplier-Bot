import { randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { getDatabase } from './mongo.js';

interface LeaseRecord {
  _id: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function withMongoLease<T>(input: {
  collectionName: string;
  leaseKey: string;
  ownerHint: string;
  leaseMs?: number;
  acquireTimeoutMs?: number;
}, task: () => Promise<T>): Promise<T> {
  const db = await getDatabase();
  const store = db.collection<LeaseRecord>(input.collectionName);
  const owner = `${input.ownerHint}:${randomUUID()}`;
  const leaseMs = input.leaseMs ?? 60_000;
  const deadline = Date.now() + (input.acquireTimeoutMs ?? 30_000);

  for (;;) {
    const now = new Date();
    let acquired = false;
    try {
      const result = await store.updateOne(
        {
          _id: input.leaseKey,
          $or: [
            { expiresAt: { $lte: now } },
            { owner },
          ],
        },
        {
          $set: {
            owner,
            acquiredAt: now,
            expiresAt: new Date(now.getTime() + leaseMs),
          },
        },
        { upsert: true },
      );
      acquired = result.matchedCount === 1 || result.upsertedCount === 1;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }

    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring Mongo lease ${input.collectionName}/${input.leaseKey}`);
    }
    await sleep(50);
  }

  // Without renewal, expiresAt is only ever set once at acquire time above.
  // If task() runs longer than leaseMs, expiresAt passes while we're still
  // working and a second caller's acquire loop will see it as free and take
  // over -- genuine split-brain, two holders running the same logical
  // operation at once. Renewing on a fraction of leaseMs keeps expiresAt in
  // the future for as long as this holder is actually still running the
  // task, and only extends its own lease document (matched by owner), so a
  // renewal that fires after the lease has already been reclaimed by
  // someone else is a harmless no-op rather than an incorrect steal-back.
  const renewIntervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const renewTimer = setInterval(() => {
    void store.updateOne(
      { _id: input.leaseKey, owner },
      { $set: { expiresAt: new Date(Date.now() + leaseMs) } },
    ).catch(() => undefined);
  }, renewIntervalMs);
  renewTimer.unref();

  try {
    return await task();
  } finally {
    clearInterval(renewTimer);
    await store.deleteOne({ _id: input.leaseKey, owner }).catch(() => undefined);
  }
}
