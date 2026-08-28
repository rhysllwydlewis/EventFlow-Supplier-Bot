import { randomUUID } from 'node:crypto';
import { getDatabase } from '../lib/mongo.js';

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export async function recordAuditEvent(
  actor: string,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const db = await getDatabase();
  const event: AuditEvent = {
    id: randomUUID(),
    actor,
    action,
    details,
    createdAt: new Date().toISOString(),
  };
  await db.collection<AuditEvent>('audit_events').insertOne(event);
}

export async function listAuditEventsByAction(action: string, limit = 100): Promise<AuditEvent[]> {
  const db = await getDatabase();
  return db
    .collection<AuditEvent>('audit_events')
    .find({ action })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
}
