import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { campaignSchema, southWalesVenuePilot, type Campaign } from '../domain/campaign.js';
import { getDatabase } from '../lib/mongo.js';

async function collection(): Promise<Collection<Campaign>> {
  const db = await getDatabase();
  return db.collection<Campaign>('campaigns');
}

export async function ensurePilotCampaign(): Promise<Campaign> {
  const store = await collection();
  const pilot = southWalesVenuePilot();
  const existing = await store.findOne({ id: pilot.id });
  if (existing) {
    return campaignSchema.parse(existing);
  }
  await store.insertOne(pilot);
  return pilot;
}

export async function listCampaigns(): Promise<Campaign[]> {
  const store = await collection();
  const records = await store.find({ status: { $ne: 'archived' } }).sort({ priority: -1, createdAt: 1 }).toArray();
  return records.map(record => campaignSchema.parse(record));
}

export async function createCampaign(
  input: Pick<Campaign, 'name' | 'categories' | 'locations' | 'dailyTarget' | 'dailyHardLimit' | 'minimumPublicationQuality'> & Partial<Pick<Campaign, 'priority'>>,
): Promise<Campaign> {
  const now = new Date().toISOString();
  const campaign = campaignSchema.parse({
    id: `campaign_${randomUUID()}`,
    ...input,
    priority: input.priority ?? 50,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  });
  if (campaign.dailyTarget > campaign.dailyHardLimit) {
    throw new Error('Campaign daily target cannot exceed its hard limit');
  }
  const store = await collection();
  await store.insertOne(campaign);
  return campaign;
}

export async function updateCampaign(
  id: string,
  patch: Partial<Omit<Campaign, 'id' | 'createdAt'>>,
): Promise<Campaign> {
  const store = await collection();
  const existing = await store.findOne({ id });
  if (!existing) {
    throw new Error('Campaign not found');
  }
  const updated = campaignSchema.parse({
    ...existing,
    ...patch,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (updated.dailyTarget > updated.dailyHardLimit) {
    throw new Error('Campaign daily target cannot exceed its hard limit');
  }
  await store.replaceOne({ id }, updated);
  return updated;
}
