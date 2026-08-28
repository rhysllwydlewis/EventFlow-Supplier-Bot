import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync('src/services/shadow-profile-review.service.ts', 'utf8');
const repository = readFileSync('src/repositories/shadow-profile.repository.ts', 'utf8');
const server = readFileSync('src/control/server.ts', 'utf8');
const html = readFileSync('public/control.html', 'utf8');

describe('Removing a Shadow profile from review', () => {
  it('deletes the profile, suppresses future rediscovery/publication, and records why', () => {
    // An operator rejecting a candidate here is a judgement call ("doesn't
    // fit my site"), not a data-quality problem discovery/compliance would
    // ever catch on their own -- so simply deleting the shadow profile
    // isn't enough, the very next discovery cycle would just find the same
    // real website again and walk it through the full pipeline a second
    // time. Suppressing it (the same do_not_crawl/do_not_list mechanism
    // used elsewhere) is what actually makes the removal stick.
    expect(service).toContain('export async function rejectShadowProfile(candidateId: string, actor: string)');
    expect(service).toContain("type: 'do_not_crawl'");
    expect(service).toContain("type: 'do_not_list'");
    expect(service).toContain('await deleteShadowProfile(candidateId)');
    expect(service).toContain("await setCandidateStatus(candidateId, 'rejected')");
    expect(service).toContain("recordAuditEvent(actor, 'shadow_profile.rejected'");
    expect(repository).toContain('export async function deleteShadowProfile(candidateId: string)');
  });

  it('exposes the removal behind an authenticated, CSRF-protected DELETE route', () => {
    expect(server).toContain("app.delete('/api/shadow-profiles/:candidateId', requireCsrf");
    expect(server).toContain('rejectShadowProfile(');
    // Registered alongside the other authenticated API routes (after the
    // app.use('/api', requireSession) gate), not before it.
    expect(server.indexOf("app.use('/api', requireSession)")).toBeLessThan(
      server.indexOf("app.delete('/api/shadow-profiles/:candidateId'"),
    );
  });

  it('lets an operator remove a single Shadow review row with a confirmation prompt', () => {
    expect(html).toContain('class="small danger shadow-reject"');
    expect(html).toContain('if(!confirm(');
    expect(html).toContain("method:'DELETE'");
    expect(html).toContain('/api/shadow-profiles/${encodeURIComponent(button.dataset.id)}');
  });
});
