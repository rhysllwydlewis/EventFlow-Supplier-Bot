import { z } from 'zod';

const evidenceIds = z.array(z.string().min(1)).max(20);

const nullableFactSchema = z.object({
  value: z.string().max(1200).nullable(),
  evidenceIds,
});

const serviceFactSchema = z.object({
  value: z.string().min(1).max(120),
  evidenceIds,
});

const priceFactSchema = z.object({
  value: z.string().min(1).max(120),
  evidenceIds,
});

export const aiEnrichmentSchema = z.object({
  businessName: nullableFactSchema,
  location: nullableFactSchema,
  description: nullableFactSchema,
  services: z.array(serviceFactSchema).max(30),
  advertisedPrices: z.array(priceFactSchema).max(50),
  packages: z.array(z.object({
    kind: z.enum(['advertised_package', 'priced_service']),
    name: z.string().min(1).max(160),
    // Copy the supplier's commercial wording faithfully, including qualifiers
    // such as From, per person, ranges, minimum spend and VAT wording.
    priceDisplay: z.string().min(1).max(120),
    features: z.array(z.string().min(1).max(160)).max(30),
    evidenceIds,
  })).max(20),
});

export type AiEnrichment = z.infer<typeof aiEnrichmentSchema>;
