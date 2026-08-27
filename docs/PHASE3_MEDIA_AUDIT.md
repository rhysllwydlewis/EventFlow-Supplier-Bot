# Phase 3 URL and media audit

Phase 3 validates the complete Shadow research path, not just the final profile document.

## Observable research chain

For every admitted candidate the authenticated Control Centre exposes:

1. the discovery provider and search query;
2. the search-result URL returned by discovery;
3. the canonical supplier website selected for crawling;
4. the current candidate lifecycle status;
5. supplier-site pages retained as evidence during crawling;
6. ranked supplier-site-declared photo references;
7. the resulting Shadow profile and publication-quality score.

This audit view is served by `GET /api/discovery-audit` and remains behind the normal Control Centre session requirement. It is intentionally not included in the public Phase 3 progress JSON because URLs, search terms and supplier-specific research are operational data rather than aggregate status.

## Media handling in Phase 3

The crawler continues to obey the existing robots, network and crawl-budget controls. It does not download or rehost supplier image files as part of Phase 3.

Media discovery is based on references already present in crawled supplier HTML, including publisher-declared OpenGraph/Twitter images, useful same-site image elements, picture sources and bounded inline background-image references. Obvious logos, icons, tracking pixels, tiny assets, social/payment graphics and unrelated third-party inline media are filtered before selection.

A media record retains the image URL, source page URL, selection kind, bounded alt text/dimensions when declared, quality score and whether the media is same-site. This is provenance for review; it is not a licence determination and must not be treated as permission to publish or rehost the image.

## Phase 3 metrics

The validation report and public aggregate progress include:

- photo coverage: percentage of Shadow profiles with at least one selected media reference;
- average photos per Shadow profile.

These metrics supplement, rather than replace, the existing quality, evidence, deduplication, compliance and AI-cost measures.

## EventFlow handoff

When the EventFlow ingestion path is enabled in a later phase, media references may be sent with the signed Shadow payload. The EventFlow receiver must keep them as bot-acquisition source media/provenance on an unclaimed draft profile. Public supplier media fields stay empty until a later explicit rights/claim policy authorises their use.

## Safety invariants

This feature does not enable or relax any outward-facing control. During Phase 3:

- mode remains Shadow;
- Publishing remains off;
- Claim notices remain off;
- Marketing remains off;
- SEO indexing remains off;
- existing daily candidate, crawl and AI-budget ceilings remain in force.
