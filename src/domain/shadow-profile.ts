import { z } from 'zod';

export const shadowProfileSchema = z.object({
  candidateId: z.string().min(1),
  businessName: z.string().min(1).max(140),
  category: z.string().min(1).max(100),
  location: z.string().max(180).nullable(),
  website: z.string().url(),
  description: z.string().max(1200),
  publicEmail: z.string().email().nullable(),
  publicPhone: z.string().max(60).nullable(),
  advertisedPrices: z.array(z.string().max(80)).max(50),
  services: z.array(z.string().max(120)).max(30),
  packages: z.array(z.object({
    name: z.string().min(1).max(160),
    price: z.string().max(80).nullable(),
    features: z.array(z.string().max(160)).max(30),
  })).max(20),
  evidenceIds: z.array(z.string()).max(100),
  dataConfidence: z.number().min(0).max(100),
  publicationQuality: z.number().min(0).max(100),
  generatedAt: z.string(),
  generatorVersion: z.string(),
});

export type ShadowProfile = z.infer<typeof shadowProfileSchema>;
