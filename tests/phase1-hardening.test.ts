import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const identityRepository = readFileSync('src/repositories/supplier-identity.repository.ts', 'utf8');
const reconciliation = readFileSync('src/services/supplier-identity-reconciliation.service.ts', 'utf8');
const complianceRepository = readFileSync('src/repositories/compliance-assessment.repository.ts', 'utf8');
const runtimeControl = readFileSync('src/services/runtime-control.service.ts', 'utf8');
const campaignRepository = readFileSync('src/repositories/campaign.repository.ts', 'utf8');
const reassessment = readFileSync('src/services/compliance-reassessment.service.ts', 'utf8');
const safeFetch = readFileSync('src/crawler/safe-fetch.ts', 'utf8');
const robots = readFileSync('src/crawler/robots.ts', 'utf8');
const siteCrawler = readFileSync('src/crawler/site-crawler.ts', 'utf8');

describe('Phase 1 final hardening regressions', () => {
  it('serializes identity assessment and removes all partial self-owned claims', () => {
    expect(identityRepository).toContain('withSupplierIdentityLock');
    expect(identityRepository).toContain('withMongoLease');
    expect(identityRepository).toContain("deleteMany({ candidateId: identity.candidateId })");
    expect(identityRepository).toContain('if (!duplicateKey(error)) throw error');
    expect(reconciliation).toContain('withSupplierIdentityLock(profile.candidateId');
    expect(reconciliation).toContain('removeSupplierIdentity(profile.candidateId)');
  });

  it('streams the full historical dedup backlog instead of applying a terminal cap', () => {
    expect(reconciliation).toContain('.batchSize(250)');
    expect(reconciliation).toContain('for await (const candidate of cursor)');
    expect(reconciliation).not.toContain('.limit(5000)');
  });

  it('serializes quality-floor mutations with autonomous reassessment', () => {
    expect(complianceRepository).toContain('withCompliancePolicyLock');
    expect(runtimeControl).toContain('qualityFloorChanged');
    expect(runtimeControl).toContain('patch.minimumPublicationQuality !== before.minimumPublicationQuality');
    expect(campaignRepository).toContain('withCompliancePolicyLock(`campaign:${id}`');
    expect(campaignRepository).toContain('await invalidateComplianceAssessmentsForCampaign(id)');
    expect(reassessment).toContain('withCompliancePolicyLock(`reassess:${candidateId}`');
  });

  it('fails closed on temporary robots errors and respects sitemap request cadence', () => {
    expect(safeFetch).toContain('export class SafeFetchError');
    expect(robots).toContain('error instanceof SafeFetchError');
    expect(robots).toContain('error.status === 404 || error.status === 410');
    expect(robots).toContain('could not safely determine robots policy');
    expect(siteCrawler).toContain('sitemapLinks(finalRoot, policy.sitemaps, policy.crawlDelayMs)');
    expect(siteCrawler).toContain('await sleep(crawlDelayMs)');
    expect(siteCrawler).toContain('await sleep(policy.crawlDelayMs);\n  const root');
  });
});
