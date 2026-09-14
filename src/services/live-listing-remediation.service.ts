import { getDatabase } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import {
  getCandidateByCanonicalDomain,
  setCandidateCategoryHint,
  setCandidateStatus,
} from '../repositories/candidate.repository.js';
import { enqueueForcedCrawlCandidate } from './crawl-queue.service.js';
import { unpublishFromEventFlow } from './eventflow-unpublish.service.js';

// One-off, manually-reviewed corrections for specific listings a full manual
// QA pass (2026-09-14) found live and wrong on EventFlow, run automatically
// once on worker startup rather than through an HTTP admin endpoint --
// see the PR this shipped in for why (no interactive admin session was
// available to trigger it by hand). Each entry is a real production
// incident, not a hypothetical:
//
//  - Appleby Castle / Anglo Welsh were published from a regional directory's
//    own search/listing page (britainsfinest.co.uk, meetnorthwales.co.uk --
//    both now in BLOCKED_DISCOVERY_DOMAINS) rather than the business's own
//    site, and neither belongs on this Wales-focused marketplace at all:
//    Appleby Castle is in Cumbria, England; Anglo Welsh is a canal-boat
//    cruise operator, not a wedding venue. Unpublished, not recrawled.
//  - Faenol Fawr's cover image was a WordPress slider plugin's own
//    dummy.png (image-extractor.ts's dummy/default filter fix). Events Made
//    Simple's advertised price rendered as a bare "£". Both are genuine
//    businesses with fixable data -- forcing a fresh crawl now that PRs
//    #55-#57 are deployed should produce a corrected profile.
//  - Babs Boardwell Photography was published from her own roundup blog
//    post URL with category "Venues" (inherited from the campaign that
//    discovered her, never verified against what she actually is -- she's a
//    wedding photographer). A recrawl alone won't fix the category, since
//    shadow-profile-composer.service.ts takes it verbatim from the
//    candidate's categoryHint -- so this is the one entry with a
//    categoryHintOverride.
const REMEDIATIONS: ReadonlyArray<
  | { businessName: string; action: 'unpublish'; supplierId: string; reason: string }
  | {
      businessName: string;
      action: 'recrawl';
      canonicalDomain: string;
      categoryHintOverride?: string;
      reason: string;
    }
> = [
  {
    businessName: 'Appleby Castle',
    action: 'unpublish',
    supplierId: 'sup_bot_bce520ad8443f3d61efcec0f',
    reason: 'Published from a directory search-results page; wrong region (Cumbria, not Wales)',
  },
  {
    businessName: 'Anglo Welsh',
    action: 'unpublish',
    supplierId: 'sup_bot_b554aaff5429b7318128e9a8',
    reason: 'Published from a directory listings page; a canal-boat cruise operator, not a venue',
  },
  {
    businessName: 'Faenol Fawr Country House and Barn',
    action: 'recrawl',
    canonicalDomain: 'faenolfawrhotel.co.uk',
    reason: 'Cover image was a plugin placeholder (dummy.png); too few gallery photos',
  },
  {
    businessName: 'Events Made Simple',
    action: 'recrawl',
    canonicalDomain: 'eventsmadesimple.co.uk',
    reason: 'Advertised price rendered as a bare "£" with no amount',
  },
  {
    businessName: 'Babs Boardwell Photography',
    action: 'recrawl',
    canonicalDomain: 'babsboardwellweddings.co.uk',
    categoryHintOverride: 'Photography',
    reason: 'Published as category Venues; she is a wedding photographer',
  },
];

// _v2: the first deployed run (2026-09-14T11:56Z, before this fix) hit two
// real bugs and still marked itself complete, so a stale v1 record must
// never block this corrected logic from actually running:
//  1. It reached EventFlow while that repo's own PR (#1666) was still mid-
//     deploy, so the unpublish endpoint didn't exist yet -- both calls got
//     a plain Express 404, which the client reports as status 'not_found'.
//     v1 treated 'not_found' as terminal (indistinguishable from "this
//     supplier ID genuinely doesn't exist"), so it never retried.
//  2. All three recrawl targets already had a job under either the day-
//     scoped or legacy crawl jobId (organic activity earlier the same day),
//     so enqueueCrawlCandidate's dedup -- meant to stop double-discovery,
//     not to be overridden -- silently queued nothing for any of them.
const MIGRATION_ID = 'live_listing_remediation_2026_09_14_v2';

interface MigrationRecord {
  id: string;
  completedAt: string;
}

export async function runLiveListingRemediation(): Promise<void> {
  const db = await getDatabase();
  const migrations = db.collection<MigrationRecord>('maintenance_migrations');
  if (await migrations.findOne({ id: MIGRATION_ID })) {
    return;
  }

  // This bot repo's own PR ships before the EventFlow endpoint it calls is
  // guaranteed to be deployed (rhysllwydlewis/EventFlow#1666) -- two separate
  // repos, two separate deploys, no ordering guarantee between them. If an
  // unpublish call fails for a reason that could resolve itself (the
  // endpoint not deployed yet, a transient network error), the whole
  // migration must stay retryable on the next worker restart rather than
  // being marked done after one attempt that silently never fixed anything.
  let allTerminal = true;

  for (const item of REMEDIATIONS) {
    try {
      if (item.action === 'unpublish') {
        const result = await unpublishFromEventFlow({
          candidateId: item.businessName,
          supplierId: item.supplierId,
          reason: item.reason,
        });
        logger.info({ businessName: item.businessName, result }, 'Live listing remediation: unpublish attempted');
        // 'not_found' is deliberately NOT treated as terminal here: EventFlow
        // returns the same 404 whether this specific supplier ID genuinely
        // doesn't exist, or the /unpublish route itself doesn't exist yet on
        // a not-fully-deployed instance -- confirmed live (see MIGRATION_ID's
        // v2 comment). A supplier ID hardcoded above that turns out to be
        // permanently wrong would retry forever rather than fail loudly, but
        // that is the safer failure mode for live public-listing data.
        if (result.status !== 'unpublished' && result.status !== 'not_bot_managed') {
          allTerminal = false;
        }
        continue;
      }

      const candidate = await getCandidateByCanonicalDomain(item.canonicalDomain);
      if (!candidate) {
        logger.warn({ businessName: item.businessName, domain: item.canonicalDomain }, 'Live listing remediation: candidate not found, skipping');
        await recordAuditEvent('live-listing-remediation', 'remediation.candidate_not_found', {
          businessName: item.businessName,
          canonicalDomain: item.canonicalDomain,
        });
        continue;
      }

      if (item.categoryHintOverride && candidate.categoryHint !== item.categoryHintOverride) {
        await setCandidateCategoryHint(candidate.id, item.categoryHintOverride);
      }
      await setCandidateStatus(candidate.id, 'queued_for_crawl');
      // Not enqueueCrawlCandidate: every one of these candidates was already
      // crawled once (that's how it got published), so its dedup -- an
      // existing job under the day-scoped or legacy jobId -- would silently
      // refuse to queue a fresh crawl. Confirmed live: all three recrawl
      // targets hit exactly this in the v1 run.
      await enqueueForcedCrawlCandidate(candidate.id, 'live_listing_remediation');
      await recordAuditEvent('live-listing-remediation', 'remediation.recrawl_queued', {
        businessName: item.businessName,
        candidateId: candidate.id,
        canonicalDomain: item.canonicalDomain,
        categoryHintOverride: item.categoryHintOverride ?? null,
        reason: item.reason,
      });
      logger.info({ businessName: item.businessName, candidateId: candidate.id }, 'Live listing remediation: recrawl queued');
    } catch (error) {
      logger.error({ err: error, businessName: item.businessName }, 'Live listing remediation: action failed');
      allTerminal = false;
    }
  }

  if (!allTerminal) {
    logger.warn('Live listing remediation: at least one action did not reach a terminal state, will retry on next worker startup');
    return;
  }

  await migrations.updateOne(
    { id: MIGRATION_ID },
    { $set: { id: MIGRATION_ID, completedAt: new Date().toISOString() } },
    { upsert: true },
  );
}
