import { getDatabase } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import {
  getCandidateByCanonicalDomain,
  setCandidateCanonicalUrl,
  setCandidateCategoryHint,
  setCandidateStatus,
} from '../repositories/candidate.repository.js';
import { enqueueForcedCrawlCandidate } from './crawl-queue.service.js';
import { unpublishFromEventFlow } from './eventflow-unpublish.service.js';

type RemediationItem =
  | { businessName: string; action: 'unpublish'; supplierId: string; reason: string }
  | {
      businessName: string;
      action: 'recrawl';
      canonicalDomain: string;
      categoryHintOverride?: string;
      canonicalUrlOverride?: string;
      reason: string;
    };

interface MigrationRecord {
  id: string;
  completedAt: string;
}

// Shared by every one-off batch below. Each batch is gated on its own
// migration id (a maintenance_migrations record) rather than one shared id,
// so a later batch's real, freshly-discovered issue is never held back by an
// earlier batch's already-completed (or still-retrying) record.
async function runRemediationBatch(migrationId: string, items: readonly RemediationItem[]): Promise<void> {
  const db = await getDatabase();
  const migrations = db.collection<MigrationRecord>('maintenance_migrations');
  if (await migrations.findOne({ id: migrationId })) {
    return;
  }

  // This bot repo's own PR can ship before the EventFlow endpoint an
  // unpublish call depends on (rhysllwydlewis/EventFlow#1666) is guaranteed
  // deployed -- two separate repos, two separate deploys, no ordering
  // guarantee between them. If a call fails for a reason that could resolve
  // itself (the endpoint not deployed yet, a transient network error), the
  // batch must stay retryable on the next worker startup rather than being
  // marked done after one attempt that silently never fixed anything.
  let allTerminal = true;

  for (const item of items) {
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
        // a not-fully-deployed instance -- confirmed live in the first batch
        // this pattern ran for. A supplier ID hardcoded below that turns out
        // to be permanently wrong would retry forever rather than fail
        // loudly, but that is the safer failure mode for live public data.
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
      if (item.canonicalUrlOverride && candidate.canonicalUrl !== item.canonicalUrlOverride) {
        await setCandidateCanonicalUrl(candidate.id, item.canonicalUrlOverride);
      }
      await setCandidateStatus(candidate.id, 'queued_for_crawl');
      // Not enqueueCrawlCandidate: every one of these candidates was already
      // crawled once (that's how it got published), so its dedup -- an
      // existing job under the day-scoped or legacy jobId -- would silently
      // refuse to queue a fresh crawl. Confirmed live in the first batch
      // this pattern ran for.
      await enqueueForcedCrawlCandidate(candidate.id, 'live_listing_remediation');
      await recordAuditEvent('live-listing-remediation', 'remediation.recrawl_queued', {
        businessName: item.businessName,
        candidateId: candidate.id,
        canonicalDomain: item.canonicalDomain,
        categoryHintOverride: item.categoryHintOverride ?? null,
        canonicalUrlOverride: item.canonicalUrlOverride ?? null,
        reason: item.reason,
      });
      logger.info({ businessName: item.businessName, candidateId: candidate.id }, 'Live listing remediation: recrawl queued');
    } catch (error) {
      logger.error({ err: error, businessName: item.businessName }, 'Live listing remediation: action failed');
      allTerminal = false;
    }
  }

  if (!allTerminal) {
    logger.warn({ migrationId }, 'Live listing remediation: at least one action did not reach a terminal state, will retry on next worker startup');
    return;
  }

  await migrations.updateOne(
    { id: migrationId },
    { $set: { id: migrationId, completedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

// One-off, manually-reviewed corrections for specific listings a full manual
// QA pass (2026-09-14) found live and wrong on EventFlow, run automatically
// once on worker startup rather than through an HTTP admin endpoint -- see
// the PR this shipped in for why (no interactive admin session was
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
const BATCH_1_ITEMS: readonly RemediationItem[] = [
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
  // Manual review after this batch's recrawl found Events Made Simple isn't
  // a venue or supplier at all (a corporate event-planning/comparison
  // platform) -- BATCH_2_ITEMS below unpublishes it instead. Left as a
  // recrawl here rather than edited retroactively: this batch already ran
  // and completed in production with this exact item list, so the array
  // stays the accurate historical record of what that run actually did.
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
const BATCH_1_MIGRATION_ID = 'live_listing_remediation_2026_09_14_v2';

// Batch 2, same day: after batch 1's recrawl, all three recrawl targets came
// back compliance-blocked (confirmed live via the ineligible-reason logging
// this same session added). Manually reviewing each source site against the
// specific compliance rules found:
//  - Events Made Simple is a corporate event-planning/venue-comparison
//    platform, not a venue or supplier of its own -- operator-confirmed it
//    should never have been published as a marketplace listing at all, same
//    class of issue as Appleby Castle/Anglo Welsh in batch 1. Unpublished,
//    not recrawled again.
//  - Faenol Fawr and Babs Boardwell Photography are staying on the recrawl
//    path pending a manually-found page with their real photos/pricing (see
//    BATCH_3_ITEMS once that's available) -- not included here.
const BATCH_2_ITEMS: readonly RemediationItem[] = [
  {
    businessName: 'Events Made Simple',
    action: 'unpublish',
    supplierId: 'sup_bot_190d1dbaf5d9a46b6779949f',
    reason: 'A corporate event-planning/venue-comparison platform, not a venue or supplier itself',
  },
];
const BATCH_2_MIGRATION_ID = 'live_listing_remediation_2026_09_14_v3';

// Batch 3, same day: manually reviewing Faenol Fawr's and Babs Boardwell
// Photography's own sites (after batch 1's recrawl left both still
// compliance-blocked) found their real photos/pricing genuinely exist and
// are reachable from their homepages -- but neither candidate's
// canonicalUrl was ever corrected, so the batch-1 forced recrawl started
// from the exact same wrong page each was originally (mis)published from:
//  - Babs Boardwell's canonicalUrl was still her own roundup blog post
//    (the original bug's entry point, /my-favourite-wedding-venues-in-
//    north-wales) rather than her homepage -- a page with a thin,
//    unrelated link graph that likely never reaches her real pricing page
//    (/snowdonia-wedding-photographer/, "starting at £1000/£1200")
//    within an 8-page crawl budget.
//  - Faenol Fawr's canonicalUrl was a deep subpage
//    (/conference-and-function-rooms-north-wales), not the homepage.
//    Its real, non-placeholder photos sit on /barn-north-wales-events-venue/,
//    reachable from the homepage's main nav but never reliably reached from
//    that subpage's own, differently-shaped link graph.
// Both get canonicalUrlOverride here, alongside the same page-selector.ts
// media-term scoring fix this PR ships (so a page like Faenol Fawr's Barn
// page -- slug reading only "events-venue", no dedicated gallery term --
// competes properly for a crawl slot against pricing/menu pages once the
// crawl actually starts from a page whose nav links to it).
const BATCH_3_ITEMS: readonly RemediationItem[] = [
  {
    businessName: 'Faenol Fawr Country House and Barn',
    action: 'recrawl',
    canonicalDomain: 'faenolfawrhotel.co.uk',
    canonicalUrlOverride: 'https://faenolfawrhotel.co.uk/',
    reason: 'canonicalUrl was a deep subpage whose link graph never reached the real photos on /barn-north-wales-events-venue/',
  },
  {
    businessName: 'Babs Boardwell Photography',
    action: 'recrawl',
    canonicalDomain: 'babsboardwellweddings.co.uk',
    canonicalUrlOverride: 'https://www.babsboardwellweddings.co.uk/',
    reason: 'canonicalUrl was still her own roundup blog post (the original bug\'s entry point), not her homepage',
  },
];
const BATCH_3_MIGRATION_ID = 'live_listing_remediation_2026_09_14_v4';

export async function runLiveListingRemediation(): Promise<void> {
  await runRemediationBatch(BATCH_1_MIGRATION_ID, BATCH_1_ITEMS);
  await runRemediationBatch(BATCH_2_MIGRATION_ID, BATCH_2_ITEMS);
  await runRemediationBatch(BATCH_3_MIGRATION_ID, BATCH_3_ITEMS);
}
