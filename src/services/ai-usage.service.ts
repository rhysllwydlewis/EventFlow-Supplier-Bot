import { getDatabase } from '../lib/mongo.js';

export interface AiUsageRecord {
  provider: 'openai';
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostGbp: number;
  updatedAt: string;
}

export async function recordAiUsage(input: {
  inputTokens: number;
  outputTokens: number;
  estimatedCostGbp: number;
}): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const db = await getDatabase();
  await db.collection<AiUsageRecord>('ai_usage').updateOne(
    { provider: 'openai', day },
    {
      $inc: {
        calls: 1,
        inputTokens: Math.max(0, Math.floor(input.inputTokens)),
        outputTokens: Math.max(0, Math.floor(input.outputTokens)),
        estimatedCostGbp: Math.max(0, input.estimatedCostGbp),
      },
      $set: { updatedAt: new Date().toISOString() },
      $setOnInsert: { provider: 'openai', day },
    },
    { upsert: true },
  );
}

export async function getTodayAiUsage(): Promise<AiUsageRecord | null> {
  const day = new Date().toISOString().slice(0, 10);
  const db = await getDatabase();
  return db.collection<AiUsageRecord>('ai_usage').findOne({ provider: 'openai', day });
}
