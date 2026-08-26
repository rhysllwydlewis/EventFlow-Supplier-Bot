const HREF_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function extractLinks(html: string, baseUrl: string, maxLinks = 500): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = HREF_RE.exec(html)) && links.size < maxLinks) {
    const raw = (match[1] || match[2] || match[3] || '').trim();
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
