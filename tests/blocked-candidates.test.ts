import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('src/control/server.ts', 'utf8');
const html = readFileSync('public/control.html', 'utf8');
const ingestionRepo = readFileSync('src/repositories/eventflow-ingestion.repository.ts', 'utf8');

describe('Surfacing publish attempts EventFlow rejected as duplicates', () => {
  it('exposes candidates EventFlow refused because a supplier with that website already exists', () => {
    // ingestShadowProfileToEventFlow records status 'conflict' when EventFlow's
    // own website-uniqueness check (services/supplierBotIngestion.service.js,
    // EventFlow repo) rejects a publish attempt -- this is resolved, not
    // pending, and will never become publishable by retrying.
    expect(server).toContain("app.get('/api/blocked-candidates'");
    expect(server).toContain('listConflictedEventFlowIngestions(');
    expect(ingestionRepo).toContain('export async function listConflictedEventFlowIngestions');
    expect(ingestionRepo).toContain("find({ status: 'conflict' })");
  });

  it('joins each blocked candidate back to its shadow profile for a business name and website', () => {
    const handlerStart = server.indexOf("app.get('/api/blocked-candidates'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('getShadowProfilesForCandidateIds(');
    expect(handler).toContain('businessName: profile?.businessName ?? null');
    expect(handler).toContain('website: profile?.website ?? null');
  });

  it('drops a conflicted candidate out of Shadow review instead of leaving it marked Ready forever', () => {
    const handlerStart = server.indexOf("app.get('/api/shadow-profile-reviews'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('listConflictedEventFlowIngestions(500)');
    expect(handler).toContain('conflictedCandidateIds.has(profile.candidateId)');
  });

  it('renders a Blocked card on the dashboard', () => {
    expect(html).toContain('id="blockedRows"');
    expect(html).toContain("request('/api/blocked-candidates?limit=20')");
    expect(html).toContain('>Blocked<');
    expect(html).toContain('already has a supplier with this website');
  });
});
