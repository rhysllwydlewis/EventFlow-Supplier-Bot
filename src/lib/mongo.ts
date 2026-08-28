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
    db.collection('candidates').createIndex({ canonicalDomain: 1 }, { unique: true, sparse: true }),
    db.collection('candidates').createIndex({ status: 1, updatedAt: -1 }),
    db.collection('candidates').createIndex({ dedupDecision: 1, updatedAt: -1 }),
    db.collection('evidence_fragments').createIndex({ candidateId: 1, observedAt: 1 }),
    db.collection('provider_usage').createIndex({ provider: 1, day: 1 }, { unique: true }),
    db.collection('ai_usage').createIndex({ provider: 1, day: 1 }, { unique: true }),
    db.collection('ai_extractions').createIndex({ candidateId: 1, createdAt: -1 }),
    db.collection('provider_circuits').createIndex({ id: 1 }, { unique: true }),
    db.collection('runtime_counters').createIndex({ id: 1 }, { unique: true }),
    db.collection('compliance_assessments').createIndex({ candidateId: 1 }, { unique: true }),
    db.collection('compliance_assessments').createIndex({ publicationEligible: 1, seoIndexEligible: 1, assessedAt: -1 }),
    db.collection('supplier_identities').createIndex({ candidateId: 1 }, { unique: true }),
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
    // published_suppliers is checked once per discovered search result on the
    // primary discovery hot path (getPublishedSupplierByDomain), and its
    // upsert-by-domain relies on this being unique to avoid a concurrent
    // race creating two published-supplier records for the same domain.
    db.collection('published_suppliers').createIndex({ canonicalDomain: 1 }, { unique: true }),
    db.collection('published_suppliers').createIndex({ publishedAt: -1 }),
  ]);
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
  client = null;
  database = null;
}
