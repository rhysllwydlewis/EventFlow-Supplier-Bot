import { getDatabase } from '../lib/mongo.js';

export type SuppressionType = 'do_not_crawl' | 'do_not_list' | 'do_not_contact';

export interface SuppressionRecord {
  key: string;
  type: SuppressionType;
  reason: string;
  permanent: boolean;
  createdAt: string;
  createdBy: string;
}

export async function isSuppressed(key: string, type: SuppressionType): Promise<boolean> {
  const db = await getDatabase();
  return Boolean(await db.collection<SuppressionRecord>('suppression').findOne({ key, type }));
}

export async function addSuppression(record: Omit<SuppressionRecord, 'createdAt'>): Promise<void> {
  const db = await getDatabase();
  const document: SuppressionRecord = { ...record, createdAt: new Date().toISOString() };
  await db.collection<SuppressionRecord>('suppression').updateOne(
    { key: record.key, type: record.type },
    { $set: document },
    { upsert: true },
  );
}
