import { z } from 'zod';

export const dedupDecisionSchema = z.enum(['strong_duplicate', 'probable_duplicate', 'distinct']);

export const supplierIdentitySchema = z.object({
  candidateId: z.string().min(1),
  canonicalDomain: z.string().min(1),
  normalizedName: z.string().min(1),
  normalizedLocation: z.string().nullable(),
  normalizedCategory: z.string().nullable(),
  normalizedEmail: z.string().nullable(),
  normalizedPhone: z.string().nullable(),
  profileGeneratedAt: z.string(),
  indexedAt: z.string(),
});

export const dedupAssessmentSchema = z.object({
  candidateId: z.string().min(1),
  decision: dedupDecisionSchema,
  matchedCandidateId: z.string().nullable(),
  score: z.number().min(0).max(100),
  signals: z.array(z.string().min(1).max(80)).max(20),
  policyVersion: z.string().min(1),
  assessedAt: z.string(),
});

export type SupplierIdentity = z.infer<typeof supplierIdentitySchema>;
export type DedupAssessment = z.infer<typeof dedupAssessmentSchema>;
export type DedupDecision = z.infer<typeof dedupDecisionSchema>;
