import { getQueue } from '../queues/index.js';
import {
  listRetryableEventFlowCandidateIds,
  saveEventFlowIngestionState,
} from '../repositories/eventflow-ingestion.repository.js';

export async function enqueueEventFlowPublication(
  candidateId: string,
  trigger: string,
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const job = await getQueue('publication').add(
    'publish-to-eventflow',
    { candidateId, trigger },
    {
      jobId: `eventflow-${candidateId}-${bucket}`,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
  return Boolean(job.id);
}

export async function markEventFlowPublicationPending(candidateId: string, reason: string): Promise<void> {
  await saveEventFlowIngestionState({
    candidateId,
    status: 'pending',
    reason,
    nextRetryAt: null,
  });
}

export async function reconcileEventFlowPublicationQueue(limit = 100): Promise<number> {
  const candidateIds = await listRetryableEventFlowCandidateIds(limit);
  let queued = 0;
  for (const candidateId of candidateIds) {
    if (await enqueueEventFlowPublication(candidateId, 'reconciliation')) queued += 1;
  }
  return queued;
}
