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
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('status.metrics?.crawlsToday');
    expect(html).toContain('status.metrics?.aiEstimatedCostGbpToday');
    expect(html).toContain('status.metrics?.aiReservedGbp');
  });

  it('surfaces Phase 3 progress, cost, quality and the safety contract', () => {
    for (const id of [
      'phase3Candidates',
      'phase3Profiles',
      'phase3Quality',
      'phase3Evidence',
      'phase3Duplicates',
      'phase3Cost',
      'phase3Safety',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("request('/api/phase3-validation')");
    expect(html).toContain('phase3.safety');
    expect(html).toContain('phase3.readyForReview');
    expect(server).toContain("app.get('/api/phase3-validation'");
    expect(server).toContain('getPhase3ValidationReport(settings)');
  });

  it('does not clobber in-progress settings edits with the periodic status poll', () => {
    // The status poll (setInterval) calls refresh() every 15s, which used to
    // unconditionally overwrite every settings field from the server on each
    // tick. An operator editing several fields could easily take longer than
    // that, so their in-progress edits were silently reset before they ever
    // clicked Save. Editing any settings field must now mark the form dirty
    // so refresh() skips repopulating it until a save actually completes.
    expect(html).toContain('let settingsDirty=false;');
    expect(html).toMatch(/if\(!settingsDirty\)\{\s*\$\('mode'\)\.value=s\.mode;/);
    expect(html).toContain("$('settingsForm').addEventListener('input',()=>{settingsDirty=true;});");
    expect(html).toContain("$('settingsForm').addEventListener('change',()=>{settingsDirty=true;});");
    expect(html).toMatch(/settingsDirty=false;\s*await refresh\(\);/);
  });

  it('lets an operator raise a campaign\'s own daily acquisition target and hard limit', () => {
    // The global "Daily hard maximum" setting and a campaign's own daily
    // target/hard limit are two independent ceilings (daily-limit.service.ts
    // takes the stricter of the two) -- raising only the global one silently
    // does nothing if the campaign's own limit is still the binding
    // constraint. There was previously no dashboard control for the
    // campaign-level fields at all, only the global setting.
    expect(html).toContain('class="campaign-daily-target"');
    expect(html).toContain('class="campaign-daily-hard-limit"');
    expect(html).toContain('class="small campaign-save-limits"');
    expect(html).toContain("querySelectorAll('.campaign-save-limits')");
    expect(html).toContain('dailyTarget,dailyHardLimit');
    expect(server).toContain("app.patch('/api/campaigns/:id'");

    // The same 15s-poll-clobbers-in-progress-edits bug fixed for the
    // settings form applies here too: the campaign table is fully
    // regenerated from server state on every refresh() tick, so editing the
    // limit inputs must also mark the table dirty and skip repopulating it
    // until a save completes.
    expect(html).toContain('let campaignRowsDirty=false;');
    expect(html).toContain("$('campaignRows').addEventListener('input',()=>{campaignRowsDirty=true;});");
    expect(html).toMatch(/if\(!campaignRowsDirty\)\{\s*\$\('campaignRows'\)\.innerHTML=/);
    expect(html).toMatch(/campaignRowsDirty=false;\s*await refresh\(\);/);
  });
});
