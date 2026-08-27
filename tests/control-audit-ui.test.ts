import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Control Centre discovery audit UI', () => {
  it('shows the search-to-profile audit trail and media metrics on the root dashboard', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
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
  });

  it('gives visible feedback for a manual planning request rather than failing silently', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html).toContain('id="controlFeedback"');
    expect(html).toContain("setFeedback('Queuing planning cycle…')");
    expect(html).toContain('Planning cycle queued. The dashboard will update as jobs run.');
  });

  it('keeps the discovery audit endpoint behind authenticated API middleware', () => {
    const source = readFileSync(new URL('../src/control/server.ts', import.meta.url), 'utf8');
    expect(source.indexOf("app.use('/api', requireSession)")).toBeLessThan(
      source.indexOf("app.get('/api/discovery-audit'"),
    );
  });
});
