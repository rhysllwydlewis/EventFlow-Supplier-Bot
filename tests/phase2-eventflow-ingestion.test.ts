import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const envSource = readFileSync('src/config/env.ts', 'utf8');
const ingestionSource = readFileSync('src/services/eventflow-ingestion.service.ts', 'utf8');
const pipelineSource = readFileSync('src/services/shadow-pipeline.service.ts', 'utf8');

describe('Phase 2 EventFlow ingestion contract', () => {
  it('keeps EventFlow integration optional and secret-backed', () => {
    expect(envSource).toContain('EVENTFLOW_INTERNAL_BASE_URL');
    expect(envSource).toContain('EVENTFLOW_BOT_HMAC_SECRET');
    expect(ingestionSource).toContain("createHmac('sha256'");
    expect(ingestionSource).toContain('x-eventflow-bot-timestamp');
    expect(ingestionSource).toContain('x-eventflow-bot-signature');
  });

  it('targets only the internal versioned ingestion endpoint', () => {
    expect(ingestionSource).toContain('/api/v1/internal/supplier-bot/suppliers');
  });

  it('refuses ingestion while publishing is disabled or compliance is ineligible', () => {
    expect(ingestionSource).toContain("status: 'disabled'");
    expect(ingestionSource).toContain('publishing_disabled');
    expect(ingestionSource).toContain('compliance.publicationEligible');
    expect(ingestionSource).toContain('compliance_not_publication_eligible');
  });

  it('runs ingestion only after dedup and compliance are complete', () => {
    const dedupIndex = pipelineSource.indexOf('assessAndPersistSupplierDuplicate');
    const complianceIndex = pipelineSource.indexOf('saveComplianceAssessment');
    const ingestionIndex = pipelineSource.indexOf('ingestShadowProfileToEventFlow({');
    expect(dedupIndex).toBeGreaterThan(-1);
    expect(complianceIndex).toBeGreaterThan(dedupIndex);
    expect(ingestionIndex).toBeGreaterThan(complianceIndex);
    expect(pipelineSource).toContain('publishingEnabled: settings.publishingEnabled');
  });
});
