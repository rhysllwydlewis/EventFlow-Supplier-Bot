import type { AiEnrichment } from '../domain/ai-enrichment.js';
import { getDatabase } from '../lib/mongo.js';

export interface StoredAiExtraction {
  candidateId: string;
  provider: 'openai';
  model: string;
  responseId: string | null;
  extraction: AiEnrichment;
  inputTokens: number;
  outputTokens: number;
  estimatedCostGbp: number;
  createdAt: string;
}

export async function saveAiExtraction(record: Omit<StoredAiExtraction, 'createdAt'>): Promise<void> {
  const db = await getDatabase();
  await db.collection<StoredAiExtraction>('ai_extractions').insertOne({
    ...record,
    createdAt: new Date().toISOString(),
  });
}
