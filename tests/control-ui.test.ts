import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');

describe('Supplier Bot Control Centre review surface', () => {
  it('loads compliance assessments alongside Shadow profiles', () => {
    expect(html).toContain("request('/api/compliance-assessments?limit=100')");
    expect(html).toContain("request('/api/shadow-profiles?limit=20')");
    expect(html).toContain('new Map((compliance.items||[]).map(item=>[item.candidateId,item]))');
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
