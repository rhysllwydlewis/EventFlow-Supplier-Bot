import { env } from '../config/env.js';
import { getDatabase } from '../lib/mongo.js';

interface ProviderCircuit {
  id: string;
  consecutiveFailures: number;
  openUntil: string | null;
  updatedAt: string;
}

const CIRCUIT_ID = 'provider:openai';

async function store() {
  const db = await getDatabase();
  return db.collection<ProviderCircuit>('provider_circuits');
}

export async function openAiCircuitAllowsRequest(): Promise<boolean> {
  const record = await (await store()).findOne({ id: CIRCUIT_ID });
  if (!record?.openUntil) {
    return true;
  }
  return Date.parse(record.openUntil) <= Date.now();
}

export async function recordOpenAiSuccess(): Promise<void> {
  await (await store()).updateOne(
    { id: CIRCUIT_ID },
    {
      $set: {
        consecutiveFailures: 0,
        openUntil: null,
        updatedAt: new Date().toISOString(),
      },
      $setOnInsert: { id: CIRCUIT_ID },
    },
    { upsert: true },
  );
}

export async function recordOpenAiFailure(): Promise<void> {
  const collection = await store();
  await collection.updateOne(
    { id: CIRCUIT_ID },
    {
      $inc: { consecutiveFailures: 1 },
      $set: { updatedAt: new Date().toISOString() },
      $setOnInsert: { id: CIRCUIT_ID, openUntil: null },
    },
    { upsert: true },
  );

  const record = await collection.findOne({ id: CIRCUIT_ID });
  if ((record?.consecutiveFailures ?? 0) >= env.OPENAI_CIRCUIT_FAILURE_THRESHOLD) {
    const openUntil = new Date(Date.now() + env.OPENAI_CIRCUIT_OPEN_MINUTES * 60_000).toISOString();
    await collection.updateOne(
      { id: CIRCUIT_ID },
      { $set: { openUntil, updatedAt: new Date().toISOString() } },
    );
  }
}
