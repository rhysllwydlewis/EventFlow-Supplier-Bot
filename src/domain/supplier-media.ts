import { z } from 'zod';

export const supplierMediaEvidenceSchema = z.object({
  url: z.string().url().max(2_048),
  sourcePageUrl: z.string().url().max(2_048),
  kind: z.enum(['open_graph', 'inline_image', 'picture_source', 'background_image']),
  alt: z.string().max(300).nullable(),
  width: z.number().int().positive().max(20_000).nullable(),
  height: z.number().int().positive().max(20_000).nullable(),
  score: z.number().min(0).max(100),
  sameSite: z.boolean(),
});

export type SupplierMediaEvidence = z.infer<typeof supplierMediaEvidenceSchema>;
