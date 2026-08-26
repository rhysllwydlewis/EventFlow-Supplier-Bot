import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const envSource = readFileSync('src/config/env.ts', 'utf8');
const ingestionSource = readFileSync('src/services/eventflow-ingestion.service.ts', 'utf8');
const publicationSource = readFileSync('src/services/eventflow-publication.service.ts', 'utf8');
const queueSource = readFileSync('src/services/eventflow-publication-queue.service.ts', 'utf8');
const pipelineSource = readFileSync('src/services/shadow-pipeline.service.ts', 'utf8');
const workerSource = readFileSync('src/worker/index.ts', 'utf8');

describe('Phase 2 EventFlow ingestion contract', () => {
  it('keeps EventFlow integration optional and strongly secret-backed', () => {
    expect(envSource).toContain('EVENTFLOW_INTERNAL_BASE_URL');
    expect(envSource).toContain('EVENTFLOW_BOT_HMAC_SECRET: z.string().min(32).optional()');
    expect(ingestionSource).toContain("createHmac('sha256'");
    expect(ingestionSource).toContain('x-eventflow-bot-timestamp');
    expect(ingestionSource).toContain('x-eventflow-bot-signature');
  });

  it('targets only the internal versioned ingestion endpoint', () => {
    expect(ingestionSource).toContain('/api/v1/internal/supplier-bot/suppliers');
  });

  it('keeps direct ingestion gated by publishing and compliance', () => {
    expect(ingestionSource).toContain("status: 'disabled'");
    expect(ingestionSource).toContain('publishing_disabled');
    expect(ingestionSource).toContain('compliance.publicationEligible');
    expect(ingestionSource).toContain('compliance_not_publication_eligible');
  });

  it('queues EventFlow publication only after dedup and compliance complete', () => {
    const bodyStart = pipelineSource.indexOf('async function completeShadowProfile');
    const bodyEnd = pipelineSource.indexOf('export async function runShadowPipeline', bodyStart);
    const completeShadowProfile = pipelineSource.slice(bodyStart, bodyEnd);
    const dedupIndex = completeShadowProfile.indexOf('await assessAndPersistSupplierDuplicate');
    const complianceIndex = completeShadowProfile.indexOf(
      'await saveComplianceAssessment(assessShadowProfileCompliance',
    );
    const enqueueIndex = completeShadowProfile.indexOf(
      'await enqueueEventFlowPublication(candidate.id',
    );
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(dedupIndex).toBeGreaterThan(-1);
    expect(complianceIndex).toBeGreaterThan(dedupIndex);
    expect(enqueueIndex).toBeGreaterThan(complianceIndex);
  });

  it('re-reads live controls and compliance before the network write', () => {
    expect(publicationSource).toContain("settings.runState === 'emergency_stopped'");
    expect(publicationSource).toContain('!settings.publishingEnabled');
    expect(publicationSource).toContain('withCompliancePolicyLock');
    expect(publicationSource).toContain('const liveSettings = await getSettings()');
    expect(publicationSource).toContain('publishing_revoked_before_send');
    expect(publicationSource).toContain('assessShadowProfileCompliance');
  });

  it('has a durable publication worker and reconciliation path', () => {
    expect(queueSource).toContain("getQueue('publication').add");
    expect(queueSource).toContain('listRetryableEventFlowCandidateIds');
    expect(workerSource).toContain('handlePublicationJob');
    expect(workerSource).toContain('reconcileEventFlowPublicationQueue');
    expect(workerSource).toContain('QUEUE_NAMES.publication');
  });
});
