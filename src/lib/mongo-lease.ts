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

  try {
    return await task();
  } finally {
    await store.deleteOne({ _id: input.leaseKey, owner }).catch(() => undefined);
  }
}
