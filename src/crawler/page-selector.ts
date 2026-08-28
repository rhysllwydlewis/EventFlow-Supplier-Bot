const COMMERCIAL_PATH_TERMS = [
  'packages',
  'package',
  'pricing',
  'prices',
  'price-list',
  'pricelist',
  'rates',
  'rate-card',
  'brochure',
  'menus',
  'menu',
];

const USEFUL_PATH_TERMS = [
  'about',
  'wedding',
  'services',
  'service',
  'contact',
  'faq',
  'venue',
  'events',
];

const LOW_VALUE_PATH_TERMS = [
  'blog',
  'news',
  'privacy',
  'terms',
  'cookie',
  'login',
  'account',
  'cart',
  'checkout',
  'wp-admin',
];

export function scoreUsefulPage(url: URL, rootOrigin: string): number {
  if (url.origin !== rootOrigin) {
    return -100;
  }
  const path = `${url.pathname}${url.search}`.toLowerCase();
  if (url.pathname === '/' || url.pathname === '') {
    return 100;
  }
  // PDF brochures are discovered and recorded as commercial-source hints, but
  // are not fetched by the HTML crawler until a bounded PDF text parser is
  // explicitly available. Failing closed is preferable to unreliable OCR.
  if (/\.pdf(?:$|[?#])/i.test(url.href)) {
    return -30;
  }
  if (LOW_VALUE_PATH_TERMS.some(term => path.includes(term))) {
    return -20;
  }
  let score = 0;
  COMMERCIAL_PATH_TERMS.forEach(term => {
    if (path.includes(term)) {
      score += 35;
    }
  });
  USEFUL_PATH_TERMS.forEach(term => {
    if (path.includes(term)) {
      score += 15;
    }
  });
  score -= Math.max(0, url.pathname.split('/').filter(Boolean).length - 2) * 3;
  return score;
}

export function selectUsefulPages(rootUrl: string, candidates: string[], maxPages = 8): string[] {
  const root = new URL(rootUrl);
  const unique = new Map<string, URL>();
  unique.set(root.href, root);
  for (const value of candidates) {
    try {
      const parsed = new URL(value, root);
      parsed.hash = '';
      if (parsed.origin === root.origin) {
        unique.set(parsed.href, parsed);
      }
    } catch {
      // Invalid candidate link: ignore.
    }
  }
  return [...unique.values()]
    .map(url => ({ url, score: scoreUsefulPage(url, root.origin) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.url.href.localeCompare(b.url.href))
    .slice(0, Math.max(1, maxPages))
    .map(item => item.url.href);
}

/**
 * Picks the single best not-yet-fetched page out of the full candidate pool,
 * ignoring `maxPages` entirely (pass the whole pool so a well-scoring page
 * ranked below one already fetched is still considered). Callers drive an
 * incremental crawl loop with this: fetch the pick, mine its links into the
 * pool, ask again, until `maxPages` total fetches or no candidate remains.
 * That lets a page only reachable via a subpage's own nav/footer -- not the
 * homepage's -- still be discovered within the same page budget.
 */
export function pickNextPage(
  rootUrl: string,
  candidates: string[],
  alreadyFetched: ReadonlySet<string>,
  isAllowed: (url: string) => boolean = () => true,
): string | null {
  // Infinity, not candidates.length: selectUsefulPages always adds the root
  // URL to the pool too, so a length-sized cap can silently slice off the
  // very candidate this function exists to still find.
  const ranked = selectUsefulPages(rootUrl, candidates, Infinity);
  return ranked.filter(isAllowed).find(url => !alreadyFetched.has(url)) ?? null;
}
