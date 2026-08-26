import { z } from 'zod';

export const candidateStatusSchema = z.enum([
  'discovered',
  'suppressed',
  'duplicate',
  'queued_for_crawl',
  'crawling',
  'crawled',
  'extracting',
  'ready_for_quality',
  'shadow_ready',
  'quarantined',
  'rejected',
]);

export const candidateSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  provider: z.string().min(1),
  discoveryQuery: z.string().min(1),
  sourceUrl: z.string().url(),
  canonicalUrl: z.string().url(),
  canonicalDomain: z.string().min(1),
  titleHint: z.string().max(300).nullable(),
  snippetHint: z.string().max(1000).nullable(),
  categoryHint: z.string().nullable(),
  locationHint: z.string().nullable(),
  status: candidateStatusSchema,
  discoveredAt: z.string(),
  updatedAt: z.string(),
});

export type Candidate = z.infer<typeof candidateSchema>;
