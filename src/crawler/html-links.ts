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

const INNER_TAG_RE = /<[^>]*>/g;
function anchorText(inner: string): string {
  return decodeHrefEntities(inner.replace(INNER_TAG_RE, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface ExtractedLink {
  href: string;
  /** Visible anchor text, tags stripped, entities decoded, whitespace collapsed. Empty if the anchor had none. */
  text: string;
}

// Captures the href attribute the same way extractLinks always has, plus
// everything up to the matching `</a>` so callers can score by visible link
// text too, not just the URL path -- a nav item like
// `<a href="/w4"><span>Weddings</span></a>` has nothing useful in its path.
const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

export function extractLinksWithText(html: string, baseUrl: string, maxLinks = 500): ExtractedLink[] {
  const base = new URL(baseUrl);
  const byHref = new Map<string, string>();
  // A global RegExp carries its lastIndex across calls. Without resetting it
  // here, a previous call that exited early (maxLinks reached before the
  // string was exhausted) would leave lastIndex pointing partway into that
  // *different* html string, and this call -- on a fresh, likely shorter,
  // unrelated string -- would silently start scanning from the wrong offset
  // and could return nothing at all.
  ANCHOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHOR_RE.exec(html)) && byHref.size < maxLinks) {
    const raw = decodeHrefEntities((match[1] || match[2] || match[3] || '').trim());
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) {
      continue;
    }
    try {
      const url = new URL(raw, base);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.hash = '';
      if (!byHref.has(url.href)) {
        byHref.set(url.href, anchorText(match[4] || ''));
      }
    } catch {
      // Ignore malformed links.
    }
  }
  return [...byHref.entries()].map(([href, text]) => ({ href, text }));
}

export function extractLinks(html: string, baseUrl: string, maxLinks = 500): string[] {
  return extractLinksWithText(html, baseUrl, maxLinks).map(link => link.href);
}
