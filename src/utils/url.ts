import { domainToASCII } from 'node:url';

const DEFAULT_PORTS = new Map([
  ['http:', '80'],
  ['https:', '443'],
]);

export function canonicalizePublicHttpUrl(input: string): URL {
  const parsed = new URL(input);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP(S) URLs are supported');
  }
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  parsed.hostname = domainToASCII(parsed.hostname.toLowerCase());
  if (DEFAULT_PORTS.get(parsed.protocol) === parsed.port) {
    parsed.port = '';
  }
  if (parsed.pathname === '/') {
    parsed.pathname = '';
  }
  return parsed;
}

export function canonicalDomain(input: string): string {
  const parsed = canonicalizePublicHttpUrl(input);
  return parsed.hostname.replace(/^www\./i, '');
}
