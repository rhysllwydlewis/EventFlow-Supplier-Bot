import type { Collection } from 'mongodb';
import { z } from 'zod';
import { getDatabase } from '../lib/mongo.js';

export const ONE_PROFILE_PILOT_ID = 'eventflow-one-profile-pilot-v1';

const pilotStateSchema = z.object({
  id: z.literal(ONE_PROFILE_PILOT_ID),
  status: z.enum(['waiting', 'refreshing', 'publishing', 'published', 'failed']),
  candidateId: z.string().nullable().default(null),
  businessName: z.string().nullable().default(null),
  supplierId: z.string().nullable().default(null),
  slug: z.string().nullable().default(null),
  publicProfilePath: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  updatedAt: z.string(),
  publishedAt: z.string().nullable().default(null),
});

export type EventFlowPilotState = z.infer<typeof pilotStateSchema>;

async function collection(): Promise<Collection<EventFlowPilotState>> {
  const db = await getDatabase();
  return db.collection<EventFlowPilotState>('eventflow_pilot_state');
}

export async function getEventFlowPilotState(): Promise<EventFlowPilotState | null> {
  const store = await collection();
  const record = await store.findOne({ id: ONE_PROFILE_PILOT_ID });
  return record ? pilotStateSchema.parse(record) : null;
}

export async function saveEventFlowPilotState(
  patch: Omit<Partial<EventFlowPilotState>, 'id' | 'updatedAt'>,
): Promise<EventFlowPilotState> {
  const previous = await getEventFlowPilotState();
  const now = new Date().toISOString();
  const next = pilotStateSchema.parse({
    id: ONE_PROFILE_PILOT_ID,
    status: patch.status ?? previous?.status ?? 'waiting',
    candidateId: patch.candidateId !== undefined ? patch.candidateId : previous?.candidateId ?? null,
    businessName: patch.businessName !== undefined ? patch.businessName : previous?.businessName ?? null,
    supplierId: patch.supplierId !== undefined ? patch.supplierId : previous?.supplierId ?? null,
    slug: patch.slug !== undefined ? patch.slug : previous?.slug ?? null,
    publicProfilePath:
      patch.publicProfilePath !== undefined
        ? patch.publicProfilePath
        : previous?.publicProfilePath ?? null,
    reason: patch.reason !== undefined ? patch.reason : previous?.reason ?? null,
    updatedAt: now,
    publishedAt: patch.publishedAt !== undefined ? patch.publishedAt : previous?.publishedAt ?? null,
  });
  const store = await collection();
  await store.replaceOne({ id: ONE_PROFILE_PILOT_ID }, next, { upsert: true });
  return next;
}
