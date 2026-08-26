const USEFUL_PATH_TERMS = [
  'about',
  'wedding',
  'services',
  'service',
  'packages',
  'package',
  'pricing',
  'prices',
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
  if (LOW_VALUE_PATH_TERMS.some(term => path.includes(term))) {
    return -20;
  }
  let score = 0;
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
