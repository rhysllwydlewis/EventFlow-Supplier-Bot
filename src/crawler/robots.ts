import { SafeFetchError, safeFetchText } from './safe-fetch.js';

export interface RobotsPolicy {
  sourceUrl: string;
  rules: Array<{ allow: boolean; pattern: string }>;
  sitemaps: string[];
  crawlDelayMs: number;
}

function stripComment(line: string): string {
  const index = line.indexOf('#');
  return (index >= 0 ? line.slice(0, index) : line).trim();
}

export function parseRobots(content: string, sourceUrl: string, userAgent = 'eventflowbot'): RobotsPolicy {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }>; crawlDelayMs: number | null }> = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let sawRule = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const field = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (field === 'sitemap') {
      try { sitemaps.push(new URL(value, sourceUrl).href); } catch { /* ignore malformed sitemap */ }
      continue;
    }
    if (field === 'user-agent') {
      if (!current || sawRule) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        sawRule = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      sawRule = true;
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = Math.min(10_000, Math.round(seconds * 1000));
    }
  }

  const exact = groups.filter(group => group.agents.some(agent => agent === userAgent));
  const selected = exact.length ? exact : groups.filter(group => group.agents.includes('*'));
  return {
    sourceUrl,
    rules: selected.flatMap(group => group.rules),
    sitemaps: [...new Set(sitemaps)].slice(0, 10),
    crawlDelayMs: Math.max(750, ...selected.map(group => group.crawlDelayMs ?? 0)),
  };
}

function ruleRegex(pattern: string): RegExp {
  const endAnchored = pattern.endsWith('$');
  const source = (endAnchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${source}${endAnchored ? '$' : ''}`);
}

export function robotsAllows(policy: RobotsPolicy, url: string | URL): boolean {
  const target = url instanceof URL ? url : new URL(url);
  const path = `${target.pathname}${target.search}` || '/';
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of policy.rules) {
    if (!ruleRegex(rule.pattern).test(path)) continue;
    const length = rule.pattern.replace(/[\*$]/g, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best?.allow ?? true;
}

export async function fetchRobotsPolicy(rootUrl: string | URL): Promise<RobotsPolicy> {
  const root = rootUrl instanceof URL ? rootUrl : new URL(rootUrl);
  const robotsUrl = new URL('/robots.txt', root.origin);
  try {
    const response = await safeFetchText(robotsUrl, {
      maxBytes: 512 * 1024,
      allowedContentTypes: ['text/plain', 'text/html'],
    });
    return parseRobots(response.body, response.finalUrl);
  } catch (error) {
    if (error instanceof SafeFetchError && (error.status === 404 || error.status === 410)) {
      return { sourceUrl: robotsUrl.href, rules: [], sitemaps: [], crawlDelayMs: 750 };
    }
    const reason = error instanceof Error ? error.message : 'unknown robots fetch failure';
    throw new Error(`Crawler could not safely determine robots policy for ${robotsUrl.href}: ${reason}`);
  }
}

export function extractSitemapUrls(xml: string, baseUrl: string, maxUrls = 200): string[] {
  const values: string[] = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) && values.length < maxUrls) {
    const raw = (match[1] || '').replace(/&amp;/gi, '&').trim();
    try { values.push(new URL(raw, baseUrl).href); } catch { /* ignore malformed loc */ }
  }
  return [...new Set(values)];
}
