import { describe, expect, it } from 'vitest';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import type { SupplierMediaEvidence } from '../src/domain/supplier-media.js';
import { matchPackagePhotos } from '../src/services/package-photo-matcher.js';

function packageFixture(overrides: Partial<ShadowProfile['packages'][number]> = {}): ShadowProfile['packages'][number] {
  return {
    name: 'Silver Package',
    price: '£500',
    priceDisplay: '£500',
    kind: 'advertised_package',
    features: [],
    evidenceIds: [],
    sourceUrl: 'https://example-venue.test/weddings/silver',
    sourceObservedAt: null,
    sourceContentHash: null,
    extractionConfidence: 80,
    priceDetails: null,
    image: null,
    ...overrides,
  };
}

function mediaFixture(overrides: Partial<SupplierMediaEvidence> = {}): SupplierMediaEvidence {
  return {
    url: 'https://example-venue.test/photos/silver-table.jpg',
    sourcePageUrl: 'https://example-venue.test/weddings/silver',
    kind: 'inline_image',
    alt: 'Silver package table setting',
    width: 1200,
    height: 800,
    score: 60,
    sameSite: true,
    ...overrides,
  };
}

describe('matchPackagePhotos', () => {
  it('matches a package to a recrawled photo when both page and alt-text signals agree', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Silver Package' }],
      [packageFixture()],
      [mediaFixture()],
    );

    expect(results).toEqual([
      { packageIndex: 0, imageUrl: 'https://example-venue.test/photos/silver-table.jpg' },
    ]);
  });

  it('does not match when the photo is on a different page from the package (alt text alone is not enough)', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Silver Package' }],
      [packageFixture()],
      [mediaFixture({ sourcePageUrl: 'https://example-venue.test/gallery' })],
    );

    expect(results).toEqual([]);
  });

  it('does not match when the alt text does not name the package (page locality alone is not enough)', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Silver Package' }],
      [packageFixture()],
      [mediaFixture({ alt: 'Marquee interior at dusk' })],
    );

    expect(results).toEqual([]);
  });

  it('does not match a package with no sourceUrl -- nothing real to anchor a match to', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Silver Package' }],
      [packageFixture({ sourceUrl: null })],
      [mediaFixture()],
    );

    expect(results).toEqual([]);
  });

  it('does not match a package whose title has no significant (non-generic) words', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Package' }],
      [packageFixture({ name: 'Package' })],
      [mediaFixture({ alt: 'Package deal photo' })],
    );

    expect(results).toEqual([]);
  });

  it('ignores media with no alt text at all', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Silver Package' }],
      [packageFixture()],
      [mediaFixture({ alt: null })],
    );

    expect(results).toEqual([]);
  });

  it('only matches packages named in the audit-queue gap, not every local package', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Gold Package' }],
      [packageFixture(), packageFixture({ name: 'Gold Package', sourceUrl: 'https://example-venue.test/weddings/gold' })],
      [mediaFixture(), mediaFixture({
        url: 'https://example-venue.test/photos/gold-table.jpg',
        sourcePageUrl: 'https://example-venue.test/weddings/gold',
        alt: 'Gold package table setting',
      })],
    );

    expect(results).toEqual([
      { packageIndex: 1, imageUrl: 'https://example-venue.test/photos/gold-table.jpg' },
    ]);
  });

  it('picks the highest-scoring candidate when multiple photos on the same page match', () => {
    const results = matchPackagePhotos(
      [{ id: 'pkg_1', title: 'Silver Package' }],
      [packageFixture()],
      [
        mediaFixture({ url: 'https://example-venue.test/photos/low-score.jpg', score: 45 }),
        mediaFixture({ url: 'https://example-venue.test/photos/high-score.jpg', score: 90 }),
      ],
    );

    expect(results).toEqual([
      { packageIndex: 0, imageUrl: 'https://example-venue.test/photos/high-score.jpg' },
    ]);
  });

  it('returns no matches when the queue reports no package-photo gaps', () => {
    const results = matchPackagePhotos([], [packageFixture()], [mediaFixture()]);
    expect(results).toEqual([]);
  });

  it('does not cross-attach photos between two packages that share the same name but different source pages', () => {
    // Two genuinely distinct offerings that happen to share a title -- e.g.
    // a "Silver Package" listed separately for weddings and for corporate
    // events, each with its own page and its own photo. Each match must be
    // resolved independently against its own package's sourceUrl, never
    // collapsed by name.
    const packages = [
      packageFixture({ sourceUrl: 'https://example-venue.test/weddings/silver' }),
      packageFixture({ sourceUrl: 'https://example-venue.test/corporate/silver' }),
    ];
    const media = [
      mediaFixture({
        url: 'https://example-venue.test/photos/wedding-silver.jpg',
        sourcePageUrl: 'https://example-venue.test/weddings/silver',
        alt: 'Silver package wedding table setting',
      }),
      mediaFixture({
        url: 'https://example-venue.test/photos/corporate-silver.jpg',
        sourcePageUrl: 'https://example-venue.test/corporate/silver',
        alt: 'Silver package conference room',
      }),
    ];

    const results = matchPackagePhotos([{ id: 'pkg_1', title: 'Silver Package' }], packages, media);

    expect(results).toEqual(
      expect.arrayContaining([
        { packageIndex: 0, imageUrl: 'https://example-venue.test/photos/wedding-silver.jpg' },
        { packageIndex: 1, imageUrl: 'https://example-venue.test/photos/corporate-silver.jpg' },
      ]),
    );
    expect(results).toHaveLength(2);
  });
});
