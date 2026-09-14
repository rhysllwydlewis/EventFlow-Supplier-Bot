import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync('src/control/server.ts', 'utf8');

describe('Publication diagnostics: telling a stale failure from a live one', () => {
  it('exposes recent failed/ineligible publications with their age and retry-due state', () => {
    // /api/status only ever surfaces cumulative all-time queue counts
    // (getQueueCounts), which never decrease -- a candidate that failed
    // heavily weeks ago and one that failed a minute ago are otherwise
    // indistinguishable, which is exactly what let the AI supervisor
    // re-diagnose the same historical backlog as a fresh crisis on every
    // cycle. This endpoint gives the per-candidate updatedAt/nextRetryAt
    // needed to tell the two apart.
    expect(server).toContain("app.get('/api/publication-diagnostics'");
    expect(server).toContain('listRecentFailedEventFlowIngestions(');
    expect(server).toContain('listRetryableEventFlowCandidateIds(');
  });

  it('reports whether each failure is actually due for retry, not just that it failed', () => {
    const handlerStart = server.indexOf("app.get('/api/publication-diagnostics'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('nextRetryAt');
    expect(handler).toContain('retryDue');
    expect(handler).toContain('lastAttemptAt: item.updatedAt');
  });

  it('joins each failure back to its shadow profile for a business name and website', () => {
    const handlerStart = server.indexOf("app.get('/api/publication-diagnostics'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('getShadowProfilesForCandidateIds(');
    expect(handler).toContain('businessName: profile?.businessName ?? null');
  });

  it('also covers not-yet-published shadow-ready candidates that never reached a failed status', () => {
    // recentFailures only ever covers eventflow_ingestions.status === 'failed'
    // -- a candidate stuck on 'pending' or 'ineligible', or one with no
    // eventflow_ingestions record at all (never attempted), is invisible to
    // that list even though "why hasn't this one ever published?" is exactly
    // the question an operator needs answered for it too.
    const handlerStart = server.indexOf("app.get('/api/publication-diagnostics'");
    const handlerEnd = server.indexOf('\n});', handlerStart);
    const handler = server.slice(handlerStart, handlerEnd);
    expect(handler).toContain('notYetPublished');
    expect(handler).toContain('getEventFlowIngestionsForCandidates(');
    expect(handler).toContain("ingestionStatus: ingestion?.status ?? 'never_attempted'");
  });
});
