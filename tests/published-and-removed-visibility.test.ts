import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('src/control/server.ts', 'utf8');
const html = readFileSync('public/control.html', 'utf8');
const publishedRepo = readFileSync('src/repositories/published-supplier.repository.ts', 'utf8');
const auditRepo = readFileSync('src/repositories/audit.repository.ts', 'utf8');
const ingestionService = readFileSync('src/services/eventflow-ingestion.service.ts', 'utf8');

describe('Shadow profile review reflects real publication status', () => {
  it('drops an already-published profile from Shadow review instead of leaving it marked Ready', () => {
    // "Ready" in this table is compliance eligibility, not publication
    // status -- a profile that's actually already live on EventFlow has
    // nothing left for an operator to decide, and leaving it in the list
    // reads as "still waiting on you" when it's done. It moves to
    // /api/published-suppliers instead of staying in this list.
    expect(server).toContain('listPublishedDomains()');
    const handlerStart = server.indexOf("app.get('/api/shadow-profile-reviews'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('publishedDomains.has(canonicalDomain(profile.website))');
    expect(handler).toContain('const pending = profiles');
    expect(handler).toContain('.filter(profile => {');
    expect(handler).toContain('.slice(0, limit);');
  });

  it('over-fetches shadow profiles before filtering, so already-published profiles near the top cannot starve the pending list', () => {
    // listShadowProfiles(limit) is sorted newest-first and capped at exactly
    // `limit` -- filtering already-published profiles out *after* capping at
    // the requested page size would silently shrink (or empty) the pending
    // list once enough of the newest profiles happen to already be
    // published, hiding real pending profiles further back that were never
    // fetched at all. Fetching a larger batch before filtering, then
    // capping the *filtered* result to `limit`, is what keeps the page full.
    const handlerStart = server.indexOf("app.get('/api/shadow-profile-reviews'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('listShadowProfiles(Math.min(limit * 5, 500))');
  });

  it('exposes what has actually shipped to EventFlow, self-contained and reset-proof', () => {
    expect(server).toContain("app.get('/api/published-suppliers'");
    expect(server).toContain('listRecentPublishedSuppliers(');
    expect(publishedRepo).toContain('export async function listRecentPublishedSuppliers');
    expect(publishedRepo).toContain('export async function listPublishedDomains');
    // businessName is denormalised onto the record at write time rather than
    // joined from candidates/shadow_profiles at read time -- a join would
    // silently break once a Hard Reset wipes those collections, defeating
    // the entire point of this collection surviving a reset.
    expect(publishedRepo).toContain('businessName: z.string().default(');
    expect(ingestionService).toContain('businessName: input.profile.businessName');
  });

  it('exposes what the operator has removed, with enough context to recognise it later', () => {
    expect(server).toContain("app.get('/api/removed-candidates'");
    expect(server).toContain("listAuditEventsByAction('shadow_profile.rejected'");
    expect(auditRepo).toContain('export async function listAuditEventsByAction');
  });

  it('renders both new lists on the dashboard', () => {
    expect(html).toContain('id="publishedRows"');
    expect(html).toContain("request('/api/published-suppliers?limit=20')");
    expect(html).toContain('id="removedRows"');
    expect(html).toContain("request('/api/removed-candidates?limit=20')");
    expect(html).toContain('Published to EventFlow');
    expect(html).toContain('Removed by you');
  });
});
