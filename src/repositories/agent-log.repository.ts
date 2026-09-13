import type { Collection } from 'mongodb';
import type { AgentActionRecord, AgentActionStatus, AgentLogEntry } from '../domain/agent-log.js';
import { getDatabase } from '../lib/mongo.js';

async function logCollection(): Promise<Collection<AgentLogEntry>> {
  const db = await getDatabase();
  return db.collection<AgentLogEntry>('agent_log');
}

async function actionCollection(): Promise<Collection<AgentActionRecord>> {
  const db = await getDatabase();
  return db.collection<AgentActionRecord>('agent_actions');
}

export async function insertAgentLogEntry(entry: AgentLogEntry): Promise<AgentLogEntry> {
  await (await logCollection()).insertOne(entry);
  return entry;
}

export async function listAgentLogEntries(limit = 50): Promise<AgentLogEntry[]> {
  return (await logCollection())
    .find({})
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
}

export async function insertAgentActionRecord(record: AgentActionRecord): Promise<AgentActionRecord> {
  await (await actionCollection()).insertOne(record);
  return record;
}

export async function listPendingAgentActions(limit = 50): Promise<AgentActionRecord[]> {
  return (await actionCollection())
    .find({ status: 'pending_approval' })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
}

export async function getAgentAction(id: string): Promise<AgentActionRecord | null> {
  return (await actionCollection()).findOne({ id });
}

export async function updateAgentActionStatus(
  id: string,
  status: AgentActionStatus,
  input: { decidedBy?: string | undefined; resultDetail?: string | undefined } = {},
): Promise<void> {
  await (await actionCollection()).updateOne(
    { id },
    {
      $set: {
        status,
        decidedAt: new Date().toISOString(),
        decidedBy: input.decidedBy ?? null,
        resultDetail: input.resultDetail ?? null,
      },
    },
  );
}
