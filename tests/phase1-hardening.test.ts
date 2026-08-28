import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const identityRepository = readFileSync('src/repositories/supplier-identity.repository.ts', 'utf8');
const reconciliation = readFileSync('src/services/supplier-identity-reconciliation.service.ts', 'utf8');
const complianceRepository = readFileSync('src/repositories/compliance-assessment.repository.ts', 'utf8');
const runtimeControl = readFileSync('src/services/runtime-control.service.ts', 'utf8');
const campaignRepository = readFileSync('src/repositories/campaign.repository.ts', 'utf8');
const reassessment = readFileSync('src/services/compliance-reassessment.service.ts', 'utf8');
const safeFetch = readFileSync('src/crawler/safe-fetch.ts', 'utf8');
const robots = readFileSync('src/crawler/robots.ts', 'utf8');
const siteCrawler = readFileSync('src/crawler/site-crawler.ts', 'utf8');
const mongoLease = readFileSync('src/lib/mongo-lease.ts', 'utf8');
const mongo = readFileSync('src/lib/mongo.ts', 'utf8');
const browserNetworkProxy = readFileSync('src/crawler/browser-network-proxy.ts', 'utf8');

describe('Phase 1 final hardening regressions', () => {
  it('serializes identity assessment and removes all partial self-owned claims', () => {
    expect(identityRepository).toContain('withSupplierIdentityLock');
    expect(identityRepository).toContain('withMongoLease');
    expect(identityRepository).toContain("deleteMany({ candidateId: identity.candidateId })");
    expect(identityRepository).toContain('if (!duplicateKey(error)) throw error');
    expect(reconciliation).toContain('withSupplierIdentityLock(profile.candidateId');
    expect(reconciliation).toContain('removeSupplierIdentity(profile.candidateId)');
  });

  it('streams the full historical dedup backlog instead of applying a terminal cap', () => {
    expect(reconciliation).toContain('.batchSize(250)');
    expect(reconciliation).toContain('for await (const candidate of cursor)');
    expect(reconciliation).not.toContain('.limit(5000)');
  });

  it('serializes quality-floor mutations with autonomous reassessment', () => {
    expect(complianceRepository).toContain('withCompliancePolicyLock');
    expect(runtimeControl).toContain('qualityFloorChanged');
    expect(runtimeControl).toContain('patch.minimumPublicationQuality !== before.minimumPublicationQuality');
    expect(campaignRepository).toContain('withCompliancePolicyLock(`campaign:${id}`');
    expect(campaignRepository).toContain('await invalidateComplianceAssessmentsForCampaign(id)');
    expect(reassessment).toContain('withCompliancePolicyLock(`reassess:${candidateId}`');
  });

  it('keys each Mongo lease by its actual resource, not one shared global document', () => {
    // A per-resource ownerHint (campaign:id, reassess:candidateId,
    // settings:actor, eventflow-publication:candidateId, or a bare
    // candidateId for identity reconciliation) must be the lease's lock key
    // itself -- passing it through as only a human-readable owner label
    // alongside a hardcoded 'global' key would silently serialize every
    // unrelated caller through one lock document again.
    expect(complianceRepository).toContain('leaseKey: ownerHint');
    expect(complianceRepository).not.toContain("leaseKey: 'global'");
    expect(identityRepository).toContain('leaseKey: ownerHint');
    expect(identityRepository).not.toContain("leaseKey: 'global'");
  });

  it('renews an in-progress Mongo lease so a slow task cannot lose it to a concurrent holder', () => {
    // Without renewal, a task that runs longer than leaseMs lets expiresAt
    // pass while it is still working, and a second caller's acquire loop
    // would see the lease as free and take over -- split-brain. Renewal
    // must extend the *same* holder's document (matched by owner), not
    // reacquire a new one, or a task that outlives its lease could steal
    // back a lock someone else has since legitimately claimed.
    expect(mongoLease).toContain('setInterval');
    expect(mongoLease).toContain('{ $set: { expiresAt: new Date(Date.now() + leaseMs) } }');
    expect(mongoLease).toContain('{ _id: input.leaseKey, owner }');
    expect(mongoLease).toContain('clearInterval(renewTimer)');
  });

  it('matches potential identity duplicates on canonical domain, not just name/email/phone/location', () => {
    // Same-domain is the single highest-value dedup signal, but the match
    // query never queried by it -- the safety outcome was only correct
    // because claimStrongIdentityKeys (a separate mechanism) also keys on
    // domain and caught the collision after the fact, with a less accurate
    // audit-trail label.
    const matchStart = identityRepository.indexOf('export async function findPotentialIdentityMatches(');
    const matchBody = identityRepository.slice(matchStart, matchStart + 800);
    expect(matchBody).toContain('clauses.push({ canonicalDomain: identity.canonicalDomain })');
    expect(mongo).toContain("db.collection('supplier_identities').createIndex({ canonicalDomain: 1 })");
  });

  it('does not let a duplicate-domain conflict on an already-populated collection crash server startup', () => {
    // published_suppliers ran without a unique constraint on canonicalDomain
    // until this index was added, so a duplicate can already exist in a live
    // deployment -- exactly the race the index exists to close. Creating it
    // inside the same Promise.all as every other (already-safe) index would
    // let that one conflict fail the whole batch and crash every future boot.
    const batchStart = mongo.indexOf('await Promise.all([');
    const batchEnd = mongo.indexOf(']);', batchStart);
    const batch = mongo.slice(batchStart, batchEnd);
    expect(batch).not.toContain("canonicalDomain: 1 }, { unique: true }");
    const afterBatch = mongo.slice(batchEnd);
    expect(afterBatch).toContain("createIndex({ canonicalDomain: 1 }, { unique: true })");
    expect(afterBatch).toContain('} catch (error) {');
    expect(afterBatch).toContain('logger.error(');
  });

  it('attaches an error listener on the proxy client socket before any async DNS validation', () => {
    // An 'error' event with no listener crashes the whole worker process.
    // The listener has to be attached synchronously, before
    // resolveValidatedTarget's async DNS lookup runs, or a client that
    // disconnects/errors during that window has no handler in place yet.
    const connectStart = browserNetworkProxy.indexOf('function handleConnect(');
    const connectEnd = browserNetworkProxy.indexOf('function handleHttpRequest(');
    const handleConnectBody = browserNetworkProxy.slice(connectStart, connectEnd);
    const listenerIndex = handleConnectBody.indexOf("clientSocket.on('error'");
    const asyncIndex = handleConnectBody.indexOf('resolveValidatedTarget(');
    expect(listenerIndex).toBeGreaterThan(-1);
    expect(listenerIndex).toBeLessThan(asyncIndex);
  });

  it('forces open connections closed instead of waiting on server.close() to drain them', () => {
    // server.close() alone only stops accepting new connections and waits
    // for existing ones to end naturally -- a stuck or still-open CONNECT
    // tunnel would keep it from ever resolving.
    expect(browserNetworkProxy).toContain("server.on('connection'");
    expect(browserNetworkProxy).toContain('for (const socket of sockets) socket.destroy()');
  });

  it('indexes shadow_profiles.generatedAt, candidates.discoveredAt and audit_events.action', () => {
    // These three real query patterns previously had nothing covering
    // them: listShadowProfiles sorts by generatedAt every reconcile cycle,
    // countCandidatesDiscoveredSince(ForCampaign) filters by discoveredAt
    // on every discovery job and coverage-plan cycle, and
    // listAuditEventsByAction filters by action against indexes that only
    // covered createdAt/actor.
    expect(mongo).toContain("db.collection('shadow_profiles').createIndex({ generatedAt: -1 })");
    expect(mongo).toContain("db.collection('candidates').createIndex({ discoveredAt: -1 })");
    expect(mongo).toContain("db.collection('audit_events').createIndex({ action: 1, createdAt: -1 })");
  });

  it('fails closed on temporary robots errors and respects sitemap request cadence', () => {
    expect(safeFetch).toContain('export class SafeFetchError');
    expect(robots).toContain('error instanceof SafeFetchError');
    expect(robots).toContain('error.status === 404 || error.status === 410');
    expect(robots).toContain('could not safely determine robots policy');
    expect(siteCrawler).toContain('sitemapLinks(finalRoot, policy.sitemaps, policy.crawlDelayMs)');
    expect(siteCrawler).toContain('await sleep(crawlDelayMs)');
    expect(siteCrawler).toContain('await sleep(policy.crawlDelayMs);\n  const root');
  });
});
