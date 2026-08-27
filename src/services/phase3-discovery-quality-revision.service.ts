import { getDatabase } from '../lib/mongo.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { PHASE3_VALIDATION_ID } from './phase3-validation.service.js';

const DISCOVERY_QUALITY_REVISION = 3;

interface Phase3RevisionRecord {
  id: string;
  status: string;
  startedAt: string;
  qualityRevision?: number;
}

export async function applyPhase3DiscoveryQualityRevision(): Promise<{
  reset: boolean;
  revision: number;
}> {
  const db = await getDatabase();
  const runs = db.collection<Phase3RevisionRecord>('validation_runs');
  const run = await runs.findOne({ id: PHASE3_VALIDATION_ID });
  if (!run || run.status === 'completed' || run.qualityRevision === DISCOVERY_QUALITY_REVISION) {
    return { reset: false, revision: DISCOVERY_QUALITY_REVISION };
  }

  const now = new Date().toISOString();
  const result = await runs.updateOne(
    {
      id: PHASE3_VALIDATION_ID,
      status: { $ne: 'completed' },
      qualityRevision: { $ne: DISCOVERY_QUALITY_REVISION },
    },
    {
      $set: {
        qualityRevision: DISCOVERY_QUALITY_REVISION,
        status: 'collecting',
        startedAt: now,
        completedAt: null,
        restartRequiredAt: null,
        restartReason: null,
        updatedAt: now,
      },
    },
  );

  if (result.modifiedCount === 0) {
    return { reset: false, revision: DISCOVERY_QUALITY_REVISION };
  }

  await recordAuditEvent('phase3-quality-revision', 'phase3.validation_sample_reset', {
    previousStartedAt: run.startedAt,
    restartedAt: now,
    revision: DISCOVERY_QUALITY_REVISION,
    reason: 'supplier_media_and_discovery_audit_pipeline',
  });
  return { reset: true, revision: DISCOVERY_QUALITY_REVISION };
}
