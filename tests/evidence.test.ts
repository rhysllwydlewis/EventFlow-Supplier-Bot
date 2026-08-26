import { describe, expect, it } from 'vitest';
import { createEvidenceFragment } from '../src/evidence/evidence.js';

describe('evidence fragments', () => {
  it('hashes raw evidence while retaining only a bounded excerpt', () => {
    const raw = 'A'.repeat(5000);
    const evidence = createEvidenceFragment({
      candidateId: 'candidate_1', sourceUrl: 'https://example.com/about', sourceType: 'supplier_website',
      rawForHash: raw, excerpt: raw, metadata: {},
    });
    expect(evidence.contentHash).toHaveLength(64);
    expect(evidence.excerpt).toHaveLength(2000);
  });
});
