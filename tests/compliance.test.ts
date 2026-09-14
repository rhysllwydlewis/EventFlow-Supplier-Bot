import { describe, expect, it } from 'vitest';
import type { EvidenceFragment } from '../src/evidence/evidence.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import {
  applyDescriptionComplianceFallback,
  assessShadowProfileCompliance,
  descriptionEvidenceSimilarity,
  effectiveMinimumPublicationQuality,
} from '../src/services/compliance.service.js';

const evidence: EvidenceFragment[] = [
  {
    id: 'evidence_1',
    candidateId: 'candidate_1',
    sourceUrl: 'https://example.com/',
    sourceType: 'supplier_website',
    observedAt: '2026-08-26T00:00:00.000Z',
    contentHash: 'abc',
    excerpt: 'Our Cardiff wedding venue offers exclusive use of the ceremony room, reception hall and landscaped gardens for celebrations throughout the year.',
    metadata: {},
  },
  {
    id: 'evidence_2',
    candidateId: 'candidate_1',
    sourceUrl: 'https://example.com/contact',
    sourceType: 'supplier_website',
    observedAt: '2026-08-26T00:00:00.000Z',
    contentHash: 'def',
    excerpt: 'Example Venue is based in Cardiff and can be contacted for wedding venue hire enquiries.',
    metadata: {},
  },
];

const deterministic: ShadowProfile = {
  candidateId: 'candidate_1',
  businessName: 'Example Venue',
  category: 'Venues',
  location: 'Cardiff',
  website: 'https://example.com/',
  description: 'Example Venue is listed on EventFlow as a venues supplier serving Cardiff. This profile has been compiled from publicly available business information and can be claimed by the business owner.',
  publicEmail: 'hello@example.com',
  publicPhone: '029 2000 0000',
  advertisedPrices: ['From £900'],
  services: ['Wedding venue hire'],
  packages: [],
  evidenceIds: ['evidence_1', 'evidence_2'],
  profileImage: null,
  profileImageEvidence: null,
  coverImage: 'https://example.com/hero.jpg',
  images: ['https://example.com/hero.jpg'],
  mediaEvidence: [],
  dataConfidence: 90,
  publicationQuality: 90,
  generatedAt: '2026-08-26T00:00:00.000Z',
  generatorVersion: 'deterministic-shadow-v1',
};

describe('Shadow compliance gate', () => {
  it('detects near-verbatim source wording and falls back to publication-safe EventFlow prose', () => {
    const copied: ShadowProfile = {
      ...deterministic,
      description: evidence[0]!.excerpt,
      generatorVersion: 'deterministic+openai-structured-v1',
    };
    expect(descriptionEvidenceSimilarity(copied.description, evidence)).toBeGreaterThanOrEqual(0.65);
    const result = applyDescriptionComplianceFallback({
      profile: copied,
      deterministicProfile: deterministic,
      evidence,
    });
    expect(result.fallbackApplied).toBe(true);
    expect(result.profile.description).toBe(deterministic.description);
    expect(result.profile.description).not.toContain('Shadow-mode');
  });

  it('aggregates copied passages across different source pages', () => {
    const copiedDescription = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango';
    const splitEvidence: EvidenceFragment[] = [
      { ...evidence[0]!, id: 'split_1', excerpt: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet' },
      { ...evidence[1]!, id: 'split_2', excerpt: 'kilo lima mike november oscar papa quebec romeo sierra tango' },
    ];
    expect(descriptionEvidenceSimilarity(copiedDescription, splitEvidence)).toBeGreaterThanOrEqual(0.65);
  });

  it('uses the stricter global or campaign publication quality floor', () => {
    expect(effectiveMinimumPublicationQuality(85, 95)).toBe(95);
    expect(effectiveMinimumPublicationQuality(90, 80)).toBe(90);
    expect(effectiveMinimumPublicationQuality(75, null)).toBe(75);
  });

  it('separates publication eligibility from stricter SEO index eligibility', () => {
    const assessment = assessShadowProfileCompliance({
      profile: deterministic,
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(true);
    expect(assessment.seoIndexEligible).toBe(true);
    expect(assessment.mediaStrategy).toBe('eventflow_category_fallback');
    expect(assessment.logoStrategy).toBe('initials_tile');
  });

  it('does not invent or require pricing for an otherwise factual listing', () => {
    const profile = { ...deterministic, advertisedPrices: [], packages: [] };
    const assessment = assessShadowProfileCompliance({
      profile,
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(profile.packages).toEqual([]);
    expect(assessment.publicationEligible).toBe(true);
    expect(assessment.reasons).toContain('pricing_not_publicly_available');
  });

  it('blocks publication below the configured quality floor', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, publicationQuality: 60 },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.status).toBe('block');
    expect(assessment.reasons).toContain('quality_below_publication_threshold');
  });

  it('blocks a known directory/editorial/government/UGC domain and keeps the review table honest', () => {
    // eventflow-publication.service.ts independently refuses to publish
    // these domains regardless of compliance, but that check is invisible
    // from the Control dashboard's Shadow profile review table -- without
    // catching it here too, an operator would see "Ready" for a candidate
    // that can never actually publish.
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, website: 'https://www.hitched.co.uk/wedding-venues/' },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.status).toBe('block');
    expect(assessment.reasons).toContain('non_supplier_domain');
  });

  it('does not block a genuine supplier domain that merely resembles a directory in wording', () => {
    const assessment = assessShadowProfileCompliance({
      profile: deterministic,
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.reasons).not.toContain('non_supplier_domain');
  });

  it('blocks auto-publication of a profile with no location', () => {
    // missing_location previously only downgraded the dashboard `status` to
    // 'review' without being in blockingReasons -- but the actual publish
    // path (eventflow-publication.service.ts) checks only
    // publicationEligible, not status, so a profile with contact info but
    // no address could clear the quality bar and auto-publish anyway.
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, location: '' },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.status).toBe('block');
    expect(assessment.reasons).toContain('missing_location');
  });

  it('blocks auto-publication of a profile with no services listed', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, services: [] },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.status).toBe('block');
    expect(assessment.reasons).toContain('missing_service_depth');
  });

  it('blocks profiles that claim provenance which was not supplied to the assessment', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, evidenceIds: ['evidence_1', 'evidence_missing'] },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.seoIndexEligible).toBe(false);
    expect(assessment.reasons).toContain('unresolved_evidence_reference');
  });

  // Regression tests for four real production incidents: a batch of live
  // publishes that passed every existing check but were each visibly wrong
  // on the actual public site -- zero photos, a garbled price, a canal-boat
  // operator and a wedding photographer both published as "Venues", and a
  // Cumbria venue published under a Wales-only campaign.
  it('blocks a profile with no real photos at all', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, images: [], coverImage: null },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.reasons).toContain('missing_media');
  });

  it('blocks a price that was extracted but has no usable number in it', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, advertisedPrices: ['£'], packages: [] },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.reasons).toContain('pricing_format_invalid');
    // Distinct from the legitimate "no pricing published" case -- both
    // reasons must never fire together for the same profile.
    expect(assessment.reasons).not.toContain('pricing_not_publicly_available');
  });

  it('does not block a profile that genuinely has no pricing published', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, advertisedPrices: [], packages: [] },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.reasons).toContain('pricing_not_publicly_available');
    expect(assessment.reasons).not.toContain('pricing_format_invalid');
  });

  it('blocks a "Venues" profile whose actual content is not about hosting or hiring a venue', () => {
    // Real incident: a canal-boat cruise operator, category "Venues",
    // description entirely about skippered boat trips.
    const assessment = assessShadowProfileCompliance({
      profile: {
        ...deterministic,
        category: 'Venues',
        description: 'Offers 45-minute return skippered cruises along the canal, with onboard refreshments.',
        services: ['Boat trips'],
      },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.reasons).toContain('category_mismatch_with_content');
  });

  it('does not block a genuine venue whose description never uses one of the specific building words', () => {
    const assessment = assessShadowProfileCompliance({
      profile: {
        ...deterministic,
        category: 'Venues',
        description: 'Hosts weddings and private events for up to 120 guests in a converted function room.',
      },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.reasons).not.toContain('category_mismatch_with_content');
  });

  it('blocks a profile whose location is clearly outside the campaign\'s target region', () => {
    // Real incident: "Appleby Castle", a genuine venue in Cumbria (the Lake
    // District), published under a North Wales campaign.
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, location: 'Appleby-in-Westmorland, Cumbria' },
      evidence,
      minimumPublicationQuality: 75,
      campaignLocations: ['South Wales', 'North Wales', 'Cardiff', 'Swansea'],
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.reasons).toContain('location_outside_target_region');
  });

  it('does not block a real Welsh location that never says the word "Wales"', () => {
    // Several genuinely correct production profiles give only a town/postcode
    // (e.g. Llanfabon, Rhuddlan) with no region name at all -- a check that
    // required the word "Wales" to appear would have blocked those too.
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, location: 'Llanfabon, near Pontypridd, Mid-Glamorgan, CF37 4HP' },
      evidence,
      minimumPublicationQuality: 75,
      campaignLocations: ['South Wales', 'North Wales', 'Cardiff', 'Swansea'],
    });
    expect(assessment.reasons).not.toContain('location_outside_target_region');
  });

  it('does not apply the region check when the campaign has no declared locations', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, location: 'Appleby-in-Westmorland, Cumbria' },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.reasons).not.toContain('location_outside_target_region');
  });
});
