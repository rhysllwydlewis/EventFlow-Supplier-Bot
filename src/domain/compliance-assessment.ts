import { z } from 'zod';

export const complianceAssessmentSchema = z.object({
  candidateId: z.string().min(1),
  policyVersion: z.string().min(1),
  status: z.enum(['pass', 'review', 'block']),
  publicationEligible: z.boolean(),
  seoIndexEligible: z.boolean(),
  descriptionSimilarity: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1).max(120)).max(50),
  fallbacks: z.array(z.object({
    field: z.string().min(1).max(80),
    action: z.string().min(1).max(120),
    reason: z.string().min(1).max(180),
  })).max(30),
  mediaStrategy: z.enum(['eventflow_category_fallback', 'supplier_permitted_asset']),
  logoStrategy: z.enum(['initials_tile', 'supplier_permitted_logo']),
  assessedAt: z.string(),
});

export type ComplianceAssessment = z.infer<typeof complianceAssessmentSchema>;
