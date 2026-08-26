import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/control/server.ts', import.meta.url), 'utf8');
const complianceRepository = readFileSync(
  new URL('../src/repositories/compliance-assessment.repository.ts', import.meta.url),
  'utf8',
);

describe('Supplier Bot Control Centre review surface', () => {
  it('joins each displayed Shadow profile to its own compliance assessment', () => {
    expect(html).toContain("request('/api/shadow-profile-reviews?limit=20')");
    expect(html).not.toContain("request('/api/compliance-assessments?limit=100')");
    expect(server).toContain("app.get('/api/shadow-profile-reviews'");
    expect(server).toContain('getComplianceAssessmentsForCandidates(profiles.map(profile => profile.candidateId))');
    expect(server).toContain('assessment: byCandidate.get(profile.candidateId) ?? null');
    expect(complianceRepository).toContain('export async function getComplianceAssessmentsForCandidates');
    expect(complianceRepository).toContain('candidateId: { $in: uniqueIds }');
  });

  it('includes pending Shadow profiles in the database-wide compliance overview', () => {
    expect(html).toContain("request('/api/compliance-overview')");
    expect(html).toContain('overview.publicationEligible');
    expect(html).toContain('overview.pending');
    expect(html).toContain('overview.totalProfiles');
    expect(html).toContain('id="pendingMetric"');
    expect(html).toContain("assessment?.status||'pending'");
    expect(server).toContain("app.get('/api/compliance-overview'");
    expect(complianceRepository).toContain("db.collection('shadow_profiles')");
    expect(complianceRepository).toContain("from: 'compliance_assessments'");
    expect(complianceRepository).toContain('pending: { $sum:');
    expect(complianceRepository).toContain('totalProfiles: { $sum: 1 }');
  });

  it('shows distinct compliance, publication and SEO gates', () => {
    expect(html).toContain('<th>Compliance</th><th>Publish</th><th>SEO</th>');
    expect(html).toContain('publishReadyMetric');
    expect(html).toContain('blockedMetric');
    expect(html).toContain('seoReadyMetric');
    expect(html).toContain("assessment?.publicationEligible?'ready':'hold'");
    expect(html).toContain("assessment?.seoIndexEligible?'index':'noindex'");
  });

  it('surfaces operating guardrail telemetry', () => {
    for (const id of ['crawlMetric', 'aiCallsMetric', 'aiCostMetric', 'aiReservedMetric']) {
      expect(html).toContain(`id=\"${id}\"`);
    }
    expect(html).toContain('status.metrics?.crawlsToday');
    expect(html).toContain('status.metrics?.aiEstimatedCostGbpToday');
    expect(html).toContain('status.metrics?.aiReservedGbp');
  });
});
