import type { ShadowProfile } from '../domain/shadow-profile.js';
import type { SupplierMediaEvidence } from '../domain/supplier-media.js';

export interface PackagePhotoMatchTarget {
  id: string;
  title: string | null;
}

export interface PackagePhotoMatchResult {
  // The package's own position in the `packages` array this call was given,
  // not its name -- two packages can legitimately share a name (nothing in
  // shadowProfileSchema or the AI-enrichment package builder enforces
  // uniqueness), and keying by name alone would let one package's matched
  // photo silently overwrite a same-named sibling's, or vice versa.
  packageIndex: number;
  imageUrl: string;
}

// Words too generic to ever count as a distinguishing signal for a package
// title -- excluding them stops e.g. "Wedding Package" matching any photo
// whose alt text merely says "wedding" somewhere.
const GENERIC_PACKAGE_WORDS = new Set([
  'package', 'packages', 'the', 'and', 'for', 'with', 'our', 'your', 'a', 'an', 'of', 'to', 'on', 'in', 'plus',
]);

function significantTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !GENERIC_PACKAGE_WORDS.has(token));
}

// Deterministic, conservative photo-to-package matching for the unclaimed-
// quality audit. A recrawled image is only ever assigned to a named package
// when BOTH signals agree:
//
//   1. Page locality -- the image was found on that exact package's own
//      sourceUrl (the page the package's own data was extracted from), not
//      just "somewhere on the supplier's site".
//   2. Title coverage -- the image's alt text contains every one of the
//      package title's significant (non-generic) words.
//
// Either signal alone is too weak to write to a live listing unsupervised:
// page-locality alone can pick up an unrelated hero photo that happens to
// share the page with the package's price text; alt-text overlap alone can
// pick up a same-named package pictured on a completely different page (a
// "small" or the venue's own generic "wedding" photo elsewhere on the
// site). See docs/unclaimed-quality-progress.md's Backlog and "Discovered
// along the way" for the single-signal approaches this rejected.
//
// A package with no sourceUrl, or a title with no significant words at all
// (nothing left to require), is never matched -- there is nothing real to
// anchor a match to, so it is left for a human rather than guessed.
export function matchPackagePhotos(
  targets: PackagePhotoMatchTarget[],
  packages: ShadowProfile['packages'],
  media: SupplierMediaEvidence[],
): PackagePhotoMatchResult[] {
  const targetTitles = new Set(
    targets.map(target => target.title?.trim().toLowerCase() ?? '').filter(Boolean),
  );
  if (targetTitles.size === 0) return [];

  const results: PackagePhotoMatchResult[] = [];
  packages.forEach((pkg, packageIndex) => {
    if (!targetTitles.has(pkg.name.trim().toLowerCase())) return;
    if (!pkg.sourceUrl) return;

    const titleTokens = significantTokens(pkg.name);
    if (titleTokens.length === 0) return;

    const best = media
      .filter(item => item.sourcePageUrl === pkg.sourceUrl && item.alt)
      .filter(item => {
        const altTokens = new Set(significantTokens(item.alt ?? ''));
        return titleTokens.every(token => altTokens.has(token));
      })
      .sort((a, b) => b.score - a.score)[0];

    if (!best) return;
    results.push({ packageIndex, imageUrl: best.url });
  });
  return results;
}
