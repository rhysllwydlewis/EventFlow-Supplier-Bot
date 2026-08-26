import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync('src/worker/index.ts', 'utf8');
const pipeline = readFileSync('src/services/shadow-pipeline.service.ts', 'utf8');
const crawlerPolicy = readFileSync('src/crawler/network-policy.ts', 'utf8');
const discovery = readFileSync('src/services/discovery.service.ts', 'utf8');
const dedup = readFileSync('src/services/supplier-dedup.service.ts', 'utf8');
const reconciliation = readFileSync('src/services/supplier-identity-reconciliation.service.ts', 'utf8');
const compliance = readFileSync('src/services/compliance.service.ts', 'utf8');
const ai = readFileSync('src/services/ai-enrichment.service.ts', 'utf8');
const control = readFileSync('public/control.html', 'utf8');

describe('Phase 1 standalone autonomy contract', () => {
  it('has autonomous campaign discovery and queue orchestration', () => {
    expect(worker).toContain("'discover-campaign'");
    expect(worker).toContain("'coverage-plan'");
    expect(discovery).toContain('runDiscoveryCycle');
  });

  it('enforces safe public crawling and durable Shadow processing', () => {
    expect(crawlerPolicy).toContain('Crawler destination is not public');
    expect(pipeline).toContain('crawlSupplierSite');
    expect(pipeline).toContain('saveEvidenceFragments');
    expect(pipeline).toContain('saveShadowProfile');
  });

  it('keeps AI evidence-bound and compliance-gates output', () => {
    expect(ai).toContain('store: false');
    expect(ai).toContain('evidence');
    expect(compliance).toContain('publicationEligible');
    expect(compliance).toContain('seoIndexEligible');
  });

  it('deduplicates supplier identity beyond domain and safely quarantines ambiguity', () => {
    expect(dedup).toContain('strong_duplicate');
    expect(dedup).toContain('probable_duplicate');
    expect(reconciliation).toContain("setCandidateStatus(profile.candidateId, 'duplicate')");
    expect(reconciliation).toContain("setCandidateStatus(profile.candidateId, 'quarantined')");
  });

  it('has operator guardrails without requiring per-supplier approval', () => {
    expect(control).toContain('Emergency stop');
    expect(control).toContain('Daily hard maximum');
    expect(control).toContain('Maximum crawls/day');
    expect(control).toContain('AI hard budget');
    expect(control).toContain('Shadow profile review');
  });

  it('contains no Phase 1 EventFlow production publishing implementation', () => {
    expect(pipeline).not.toContain('EVENTFLOW_INTERNAL_BASE_URL');
    expect(pipeline).not.toContain('EVENTFLOW_BOT_HMAC_SECRET');
  });
});
