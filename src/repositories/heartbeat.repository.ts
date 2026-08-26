import { getDatabase } from '../lib/mongo.js';

export interface WorkerHeartbeat {
  workerId: string;
  processType: 'worker' | 'control';
  hostname: string;
  pid: number;
  status: 'starting' | 'ready' | 'draining' | 'stopping';
  startedAt: string;
  updatedAt: string;
  version: string;
}

export async function writeHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
  const db = await getDatabase();
  await db.collection<WorkerHeartbeat>('worker_heartbeats').replaceOne(
    { workerId: heartbeat.workerId },
    heartbeat,
    { upsert: true },
  );
}

export async function listHeartbeats(): Promise<WorkerHeartbeat[]> {
  const db = await getDatabase();
  return db.collection<WorkerHeartbeat>('worker_heartbeats').find({}).sort({ updatedAt: -1 }).toArray();
}

export function heartbeatIsFresh(heartbeat: WorkerHeartbeat, now = Date.now(), maxAgeMs = 90_000): boolean {
  const updatedAt = new Date(heartbeat.updatedAt).getTime();
  return Number.isFinite(updatedAt) && now - updatedAt <= maxAgeMs;
}
