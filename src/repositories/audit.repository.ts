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
