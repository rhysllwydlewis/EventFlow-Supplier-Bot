import { MongoServerError, type Collection } from 'mongodb';
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
  // Denormalised on write, not joined at read time -- this collection must
  // stay fully self-contained (see the reset-survival note above), and a
  // join against candidates/shadow_profiles would silently break after a
  // Hard Reset wipes those. Optional/defaulted so records written before
  // this field existed still parse.
  businessName: z.string().default(''),
});

export type PublishedSupplier = z.infer<typeof publishedSupplierSchema>;

async function collection(): Promise<Collection<PublishedSupplier>> {
  const db = await getDatabase();
  return db.collection<PublishedSupplier>('published_suppliers');
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function recordPublishedSupplier(input: {
  canonicalDomain: string;
  supplierId: string;
  slug: string;
  publicProfilePath: string | null;
  source: 'pilot' | 'campaign';
  businessName: string;
}): Promise<void> {
  const store = await collection();
  try {
    await store.updateOne(
      { canonicalDomain: input.canonicalDomain },
      {
        $set: {
          canonicalDomain: input.canonicalDomain,
          supplierId: input.supplierId,
          slug: input.slug,
          publicProfilePath: input.publicProfilePath,
          source: input.source,
          businessName: input.businessName,
        },
        $setOnInsert: { publishedAt: new Date().toISOString() },
      },
      { upsert: true },
    );
  } catch (error) {
    // Two concurrent first-time publishes of the same domain can both miss
    // the existing-document check and race to insert -- the unique index on
    // canonicalDomain is what actually prevents a duplicate record, and this
    // is that race resolving safely rather than surfacing as a failure: a
    // record for the domain now exists either way.
    if (!duplicateKey(error)) throw error;
  }
}

export async function getPublishedSupplierByDomain(domain: string): Promise<PublishedSupplier | null> {
  const store = await collection();
  const record = await store.findOne({ canonicalDomain: domain.toLowerCase() });
  return record ? publishedSupplierSchema.parse(record) : null;
}

export async function listRecentPublishedSuppliers(limit = 100): Promise<PublishedSupplier[]> {
  const store = await collection();
  const records = await store
    .find({})
    .sort({ publishedAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
  return records.map(record => publishedSupplierSchema.parse(record));
}

export async function listPublishedDomains(): Promise<Set<string>> {
  const store = await collection();
  const records = await store.find({}, { projection: { canonicalDomain: 1 } }).toArray();
  return new Set(records.map(record => record.canonicalDomain));
}
