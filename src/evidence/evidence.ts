import { createHash, randomUUID } from 'node:crypto';

export interface EvidenceFragment {
  id: string;
  candidateId: string;
  sourceUrl: string;
  sourceType: 'supplier_website' | 'structured_data' | 'discovery';
  observedAt: string;
  contentHash: string;
  excerpt: string;
  metadata: Record<string, unknown>;
}

export function createEvidenceFragment(input: Omit<EvidenceFragment, 'id' | 'observedAt' | 'contentHash'> & { rawForHash: string }): EvidenceFragment {
  return {
    id: `evidence_${randomUUID()}`,
    candidateId: input.candidateId,
    sourceUrl: input.sourceUrl,
    sourceType: input.sourceType,
    observedAt: new Date().toISOString(),
    contentHash: createHash('sha256').update(input.rawForHash).digest('hex'),
    excerpt: input.excerpt.slice(0, 2_000),
    metadata: input.metadata,
  };
}
