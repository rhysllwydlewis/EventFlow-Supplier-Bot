import type { Collection } from 'mongodb';
import { z } from 'zod';
import { getDatabase } from '../lib/mongo.js';

// Durable, reset-proof memory of "this domain is already a live EventFlow
// supplier" -- deliberately a separate collection from eventflow_ingestions
// (which Hard Reset wipes as part of resetting the Shadow pipeline) so that
// resetting the pipeline never causes the bot to forget what it has already
// published and burn crawl/AI budget rediscovering it. See hard-reset.service.ts:
// this collection must never be added to RESET_COLLECTIONS.
const publishedSupplierSchema = z.object({
  canonicalDomain: z.string().min(1),
  supplierId: z.string().min(1),
  slug: z.string().min(1),
  publicProfilePath: z.string().nullable(),
  source: z.enum(['pilot', 'campaign']),
  publishedAt: z.string(),
});

export type PublishedSupplier = z.infer<typeof publishedSupplierSchema>;

async function collection(): Promise<Collection<PublishedSupplier>> {
  const db = await getDatabase();
  return db.collection<PublishedSupplier>('published_suppliers');
}

export async function recordPublishedSupplier(input: {
  canonicalDomain: string;
  supplierId: string;
  slug: string;
  publicProfilePath: string | null;
  source: 'pilot' | 'campaign';
}): Promise<void> {
  const store = await collection();
  await store.updateOne(
    { canonicalDomain: input.canonicalDomain },
    {
      $set: {
        canonicalDomain: input.canonicalDomain,
        supplierId: input.supplierId,
        slug: input.slug,
        publicProfilePath: input.publicProfilePath,
        source: input.source,
      },
      $setOnInsert: { publishedAt: new Date().toISOString() },
    },
    { upsert: true },
  );
}

export async function getPublishedSupplierByDomain(domain: string): Promise<PublishedSupplier | null> {
  const store = await collection();
  const record = await store.findOne({ canonicalDomain: domain.toLowerCase() });
  return record ? publishedSupplierSchema.parse(record) : null;
}
