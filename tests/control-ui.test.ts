import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/control/server.ts', import.meta.url), 'utf8');
const complianceRepository = readFileSync(
  new URL('../src/repositories/compliance-assessment.repository.ts', import.meta.url),
  'utf8',
);
const liveActivity = readFileSync(new URL('../src/services/live-activity.service.ts', import.meta.url), 'utf8');

describe('Supplier Bot Control Centre review surface', () => {
  it('joins each displayed Shadow profile to its own compliance assessment', () => {
    expect(html).toContain("request('/api/shadow-profile-reviews?limit=20')");
    expect(html).not.toContain("request('/api/compliance-assessments?limit=100')");
    expect(server).toContain("app.get('/api/shadow-profile-reviews'");
    expect(server).toContain('getComplianceAssessmentsForCandidates(pending.map(profile => profile.candidateId))');
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
    expect(html).toMatch(/settingsDirty=false;[\s\S]*?await refresh\(\);/);
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
    expect(html).toMatch(/campaignRowsDirty=false;[\s\S]*?await refresh\(\);/);
  });

  it('never lets the browser heuristically cache the dashboard HTML across a deploy', () => {
    // Neither express.static's defaults nor a bare res.sendFile() set an
    // explicit Cache-Control header -- only Last-Modified/ETag. Per RFC
    // 7234 §4.2.2, a browser without an explicit directive MAY apply
    // heuristic freshness based on Last-Modified, which for a dashboard
    // that rarely changes can be long enough that a plain refresh serves
    // straight from disk cache without ever asking the server -- so a
    // deployed UI change (a new button, say) can appear missing even after
    // the operator refreshes. Both the exact-path static handler and the
    // catch-all fallback must set no-store explicitly.
    expect(server).toContain("setHeaders: res => res.set('Cache-Control', 'no-store')");
    const catchAllIndex = server.indexOf("app.get('/{*splat}'");
    expect(catchAllIndex).toBeGreaterThan(-1);
    const catchAllBody = server.slice(catchAllIndex, server.indexOf('});', catchAllIndex));
    expect(catchAllBody).toContain("res.set('Cache-Control', 'no-store')");
  });

  it('shows the search-to-profile discovery audit trail and photo coverage metrics', () => {
    // This is the operator's only window into *which real websites* the
    // bot found, crawled and turned into a Shadow profile -- without it
    // there is no way to check that discovery is finding actual supplier
    // sites rather than directories, government pages or affiliate blogs.
    expect(html).toContain('Discovery & crawl audit');
    expect(html).toContain("request('/api/discovery-audit?limit=50')");
    expect(html).toContain('id="auditRows"');
    expect(html).toContain('Identified website');
    expect(html).toContain('Pages visited');
    expect(html).toContain('Photos identified');
    expect(html).toContain('id="phase3Media"');
    expect(html).toContain('id="phase3Images"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).not.toMatch(/<img\b/i);
    expect(server).toContain("app.get('/api/discovery-audit'");
    expect(server).toContain('getDiscoveryAudit(');
  });

  it('gives visible feedback for control actions instead of failing silently', () => {
    expect(html).toContain('id="controlFeedback"');
    expect(html).toContain('function setFeedback(');
    expect(html).toContain("setFeedback('Queuing planning cycle…')");
    expect(html).toContain('Planning cycle queued. The dashboard will update as jobs run.');
  });

  it('keeps the discovery audit endpoint behind authenticated API middleware', () => {
    expect(server.indexOf("app.use('/api', requireSession)")).toBeLessThan(
      server.indexOf("app.get('/api/discovery-audit'"),
    );
  });

  it('shows what the bot is doing right now instead of just idle/running counters', () => {
    // Clicking Run only ever changed a status pill between "RUNNING" and
    // "STOPPED" with no indication of what was actually happening -- an
    // operator has no way to tell a healthy quiet moment (between the
    // 5-minute reconciler ticks) apart from a stuck worker. Live activity
    // resolves each in-flight job's candidateId/campaignId to a business
    // name or campaign name so it reads as "Crawling hensolcastle.co.uk",
    // not an opaque job id.
    expect(html).toContain("request('/api/activity')");
    expect(html).toContain('id="activityFeed"');
    expect(html).toContain('id="activitySummary"');
    expect(html).toContain('activity.items');
    expect(html).toContain('Idle — nothing running right now');
    expect(server).toContain("app.get('/api/activity'");
    expect(server).toContain('getLiveActivity()');
    expect(server.indexOf("app.use('/api', requireSession)")).toBeLessThan(
      server.indexOf("app.get('/api/activity'"),
    );
    // Only queues an operator can recognise -- extraction/enrichment/
    // compliance/composition/quality/refresh have no worker consuming them
    // (the pipeline runs inline inside the crawl handlers), so listing them
    // here would just show permanently-empty, misleading rows.
    for (const queue of ['orchestration', 'discovery', 'crawl', 'browserCrawl', 'publication']) {
      expect(liveActivity).toContain(`'${queue}'`);
    }
    expect(liveActivity).not.toContain("'extraction'");
    expect(liveActivity).not.toContain("'enrichment'");
    expect(liveActivity).not.toContain("'refresh'");
    expect(liveActivity).toContain('getCandidate(');
    expect(liveActivity).toContain('getCampaign(');
  });

  it('never lets a stray public/index.html shadow the deployed dashboard', () => {
    // express.static's default `index: 'index.html'` behaviour serves any
    // same-directory index.html for GET / *before* the catch-all route
    // below ever runs -- so a leftover index.html (e.g. an old dashboard
    // duplicate nobody deleted) would silently and permanently shadow every
    // deployed change to control.html, independent of the browser's cache,
    // DNS or extensions. Both guards matter: index:false stops this class
    // of bug outright, and the file must not exist at all so there is
    // nothing left for a future express.static default change to revive.
    expect(server).toContain('index: false,');
    expect(existsSync(new URL('../public/index.html', import.meta.url))).toBe(false);
  });
});
