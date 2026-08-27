import { z } from 'zod';
import { supplierMediaEvidenceSchema } from './supplier-media.js';

const packagePriceDetailsSchema = z.object({
  currency: z.literal('GBP'),
  amount: z.number().nonnegative().nullable(),
  maxAmount: z.number().nonnegative().nullable(),
  qualifier: z.enum(['fixed', 'from', 'range', 'minimum_spend', 'other']),
  unit: z.enum(['total', 'per_person', 'per_hour', 'per_day', 'per_event', 'per_item', 'per_night', 'other']).nullable(),
  vatStatus: z.enum(['included', 'excluded', 'unspecified']),
}).nullable();

export const shadowProfileSchema = z.object({
  candidateId: z.string().min(1),
  businessName: z.string().min(1).max(140),
  category: z.string().min(1).max(100),
  location: z.string().max(180).nullable(),
  website: z.string().url(),
  description: z.string().max(1200),
  publicEmail: z.string().email().nullable(),
  publicPhone: z.string().max(60).nullable(),
  advertisedPrices: z.array(z.string().max(120)).max(50),
  services: z.array(z.string().max(120)).max(30),
  packages: z.array(z.object({
    name: z.string().min(1).max(160),
    // price remains for backwards compatibility with the existing EventFlow
    // ingestion/materialisation contract. New records mirror priceDisplay here.
    price: z.string().max(120).nullable(),
    priceDisplay: z.string().max(120).default(''),
    kind: z.enum(['advertised_package', 'priced_service']).default('advertised_package'),
    features: z.array(z.string().max(160)).max(30),
    evidenceIds: z.array(z.string().min(1)).max(20).default([]),
    sourceUrl: z.string().url().nullable().default(null),
    sourceObservedAt: z.string().nullable().default(null),
    sourceContentHash: z.string().max(128).nullable().default(null),
    extractionConfidence: z.number().min(0).max(100).default(0),
    priceDetails: packagePriceDetailsSchema.default(null),
  })).max(20),
  evidenceIds: z.array(z.string()).max(100),
  // Phase 3 stores supplier-site-declared media references and provenance only.
  // It does not copy/rehost image bytes or grant any publication rights.
  profileImage: z.string().url().max(2_048).nullable().default(null),
  profileImageEvidence: supplierMediaEvidenceSchema.nullable().default(null),
  coverImage: z.string().url().max(2_048).nullable().default(null),
  images: z.array(z.string().url().max(2_048)).max(12).default([]),
  mediaEvidence: z.array(supplierMediaEvidenceSchema).max(20).default([]),
  dataConfidence: z.number().min(0).max(100),
  publicationQuality: z.number().min(0).max(100),
  generatedAt: z.string(),
  generatorVersion: z.string(),
});

export type ShadowProfile = z.infer<typeof shadowProfileSchema>;
