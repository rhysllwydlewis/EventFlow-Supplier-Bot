import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: MongoClient | null = null;
let database: Db | null = null;

export async function getDatabase(): Promise<Db> {
  if (database) return database;
  client = new MongoClient(env.MONGODB_URI, {
    appName: 'eventflow-supplier-bot',
    maxPoolSize: 20,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  database = client.db(env.BOT_DB_NAME);
  logger.info({ dbName: env.BOT_DB_NAME }, 'Connected to Supplier Bot MongoDB');
  return database;
}

export async function ensureMongoIndexes(): Promise<void> {
  const db = await getDatabase();
  await Promise.all([
    db.collection('bot_settings').createIndex({ id: 1 }, { unique: true }),
    db.collection('campaigns').createIndex({ id: 1 }, { unique: true }),
    db.collection('campaigns').createIndex({ status: 1, priority: -1 }),
    db.collection('worker_heartbeats').createIndex({ workerId: 1 }, { unique: true }),
    db.collection('worker_heartbeats').createIndex({ updatedAt: -1 }),
    db.collection('audit_events').createIndex({ createdAt: -1 }),
    db.collection('audit_events').createIndex({ actor: 1, createdAt: -1 }),
    // listAuditEventsByAction filters by action and sorts by createdAt --
    // without this, it falls back to the createdAt-only index above and
    // scans every event to find the ones matching action.
    db.collection('audit_events').createIndex({ action: 1, createdAt: -1 }),
    db.collection('candidates').createIndex({ canonicalDomain: 1 }, { unique: true, sparse: true }),
    db.collection('candidates').createIndex({ status: 1, updatedAt: -1 }),
    db.collection('candidates').createIndex({ dedupDecision: 1, updatedAt: -1 }),
    // Filtered on every discovery job and every coverage-plan cycle
    // (countCandidatesDiscoveredSince / countCandidatesDiscoveredSinceForCampaign).
    db.collection('candidates').createIndex({ discoveredAt: -1 }),
    db.collection('evidence_fragments').createIndex({ candidateId: 1, observedAt: 1 }),
    db.collection('provider_usage').createIndex({ provider: 1, day: 1 }, { unique: true }),
    db.collection('ai_usage').createIndex({ provider: 1, day: 1 }, { unique: true }),
    db.collection('ai_extractions').createIndex({ candidateId: 1, createdAt: -1 }),
    db.collection('provider_circuits').createIndex({ id: 1 }, { unique: true }),
    db.collection('runtime_counters').createIndex({ id: 1 }, { unique: true }),
    db.collection('compliance_assessments').createIndex({ candidateId: 1 }, { unique: true }),
    db.collection('compliance_assessments').createIndex({ publicationEligible: 1, seoIndexEligible: 1, assessedAt: -1 }),
    db.collection('supplier_identities').createIndex({ candidateId: 1 }, { unique: true }),
    // Backs the canonicalDomain clause in findPotentialIdentityMatches --
    // without it, that $or branch would need a full collection scan.
    db.collection('supplier_identities').createIndex({ canonicalDomain: 1 }),
    db.collection('supplier_identities').createIndex({ normalizedName: 1, normalizedLocation: 1, normalizedCategory: 1 }),
    db.collection('supplier_identities').createIndex({ normalizedEmail: 1 }, { sparse: true }),
    db.collection('supplier_identities').createIndex({ normalizedPhone: 1 }, { sparse: true }),
    db.collection('supplier_identity_keys').createIndex({ key: 1 }, { unique: true }),
    db.collection('supplier_identity_keys').createIndex({ candidateId: 1 }),
    db.collection('dedup_assessments').createIndex({ candidateId: 1 }, { unique: true }),
    db.collection('dedup_assessments').createIndex({ decision: 1, assessedAt: -1 }),
    db.collection('suppression').createIndex({ key: 1, type: 1 }, { unique: true }),
    db.collection('eventflow_ingestions').createIndex({ candidateId: 1 }, { unique: true }),
    db.collection('eventflow_ingestions').createIndex({ status: 1, nextRetryAt: 1, updatedAt: -1 }),
    db.collection('published_suppliers').createIndex({ publishedAt: -1 }),
    // shadow_profiles had no index at all, yet the reconcile cycle sorts it
    // by generatedAt every 5 minutes (listShadowProfiles).
    db.collection('shadow_profiles').createIndex({ generatedAt: -1 }),
  ]);

  // published_suppliers is checked once per discovered search result on the
  // primary discovery hot path (getPublishedSupplierByDomain), and its
  // upsert-by-domain relies on this being unique to avoid a concurrent race
  // creating two published-supplier records for the same domain. Unlike the
  // indexes above, this one is being added to a collection that has been
  // running *without* this constraint -- if a duplicate canonicalDomain
  // already exists from before this index existed (exactly the race it's
  // meant to close), creating it throws. That's a real data-cleanup need,
  // not a reason to fail the whole service's startup on every future boot,
  // so it's isolated from the batch above and logged instead of crashing.
  try {
    await db.collection('published_suppliers').createIndex({ canonicalDomain: 1 }, { unique: true });
  } catch (error) {
    logger.error(
      { err: error },
      'Failed to create unique index on published_suppliers.canonicalDomain -- likely duplicate records already exist and need manual cleanup before this constraint can be enforced',
    );
  }
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
  client = null;
  database = null;
}
