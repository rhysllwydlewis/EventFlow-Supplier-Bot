import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/control/server.ts', import.meta.url), 'utf8');
const complianceRepository = readFileSync(
  new URL('../src/repositories/compliance-assessment.repository.ts', import.meta.url),
  'utf8',
);

describe('Supplier Bot Control Centre review surface', () => {
  it('loads compliance assessments alongside Shadow profiles', () => {
    expect(html).toContain("request('/api/compliance-assessments?limit=100')");
    expect(html).toContain("request('/api/shadow-profiles?limit=20')");
    expect(html).toContain('new Map((compliance.items||[]).map(item=>[item.candidateId,item]))');
  });

  it('uses a database-wide compliance overview instead of sampled UI counts', () => {
    expect(html).toContain("request('/api/compliance-overview')");
    expect(html).toContain('overview.publicationEligible');
    expect(html).toContain('Database-wide latest compliance decisions across assessed profiles.');
    expect(html).not.toContain('function complianceSummary(');
    expect(html).not.toContain('for every researched profile');
    expect(server).toContain("app.get('/api/compliance-overview'");
    expect(complianceRepository).toContain('export async function getComplianceOverview()');
    expect(complianceRepository).toContain('$group');
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
