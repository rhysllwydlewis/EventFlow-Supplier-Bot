const HREF_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
// `href="/page?a=1&amp;b=2"` is ordinary, valid, and extremely common (any
// hand-written or CMS-templated query-string URL) -- the URL constructor
// does not decode HTML entities, so without this an `&amp;`-joined query
// parameter is silently mangled into part of the previous parameter's
// name/value rather than its own, and the crawler fetches (and potentially
// fails to correctly recrawl) the wrong URL.
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
};
function decodeHrefEntities(value: string): string {
  return value.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, entity => HTML_ENTITIES[entity] ?? entity);
}

export function extractLinks(html: string, baseUrl: string, maxLinks = 500): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = HREF_RE.exec(html)) && links.size < maxLinks) {
    const raw = decodeHrefEntities((match[1] || match[2] || match[3] || '').trim());
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) {
      continue;
    }
    try {
      const url = new URL(raw, base);
      if (['http:', 'https:'].includes(url.protocol)) {
        url.hash = '';
        links.add(url.href);
      }
    } catch {
      // Ignore malformed links.
    }
  }
  return [...links];
}
