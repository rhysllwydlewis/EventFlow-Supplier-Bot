import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.railway.internal',
];

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.aws.internal',
  'instance-data.ec2.internal',
]);

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

export function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

// Fully expand an IPv6 address's hextets (no "::" compression, no
// dotted-quad tail) so transition-prefix decoding below can slice fixed
// bit offsets out of it reliably.
function expandIpv6Hextets(value: string): string[] | null {
  const parts = value.split('::');
  if (parts.length > 2) return null;

  const expandSide = (side: string): string[] => (side ? side.split(':') : []);
  const head = expandSide(parts[0] ?? '');
  const tail = parts.length === 2 ? expandSide(parts[1] ?? '') : [];

  // A trailing dotted-quad (e.g. "...:1.2.3.4") counts as two hextets.
  const expandDottedQuad = (group: string[]): string[] => {
    const last = group[group.length - 1];
    if (last && last.includes('.')) {
      const ipv4 = parseIpv4(last);
      if (!ipv4) return group;
      const [a, b, c, d] = ipv4;
      return [
        ...group.slice(0, -1),
        ((a! << 8) | b!).toString(16),
        ((c! << 8) | d!).toString(16),
      ];
    }
    return group;
  };

  const expandedHead = expandDottedQuad(head);
  const expandedTail = expandDottedQuad(tail);
  const missing = 8 - (expandedHead.length + expandedTail.length);
  if (parts.length === 1) {
    return expandedHead.length === 8 ? expandedHead : null;
  }
  if (missing < 0) return null;
  return [...expandedHead, ...Array(missing).fill('0'), ...expandedTail];
}

function embeddedIpv4FromHextets(hextets: string[], startHextetIndex: number): string | null {
  const high = Number.parseInt(hextets[startHextetIndex] ?? '', 16);
  const low = Number.parseInt(hextets[startHextetIndex + 1] ?? '', 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

// NAT64 (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32) tunnel an
// IPv4 address inside specific bits of an IPv6 address. A blocklist that
// only ever inspects native IPv6 ranges never unpacks that embedded
// address, so a private or metadata IPv4 destination reachable through one
// of these transition mechanisms slips past entirely.
function embeddedTransitionIpv4(rawHextets: string[]): string | null {
  const hextets = rawHextets.map(hextet => (Number.parseInt(hextet, 16) || 0).toString(16));
  const [h0, h1] = hextets;
  if (h0 === '64' && h1 === 'ff9b' && hextets[2] === '0' && hextets[3] === '0' && hextets[4] === '0' && hextets[5] === '0') {
    // 64:ff9b::/96 -- the embedded IPv4 occupies the low 32 bits.
    return embeddedIpv4FromHextets(hextets, 6);
  }
  if (h0 === '2002') {
    // 2002:AABB:CCDD::/16 -- the embedded IPv4 is the next 32 bits.
    return embeddedIpv4FromHextets(hextets, 1);
  }
  if (h0 === '2001' && h1 === '0') {
    // 2001:0000:.../32 (Teredo) -- the embedded (obfuscated) client IPv4 is
    // the low 32 bits, XORed with 0xffffffff per RFC 4380.
    const address = embeddedIpv4FromHextets(hextets, 6);
    if (!address) return null;
    return address.split('.').map(octet => (Number(octet) ^ 0xff).toString(10)).join('.');
  }
  return null;
}

export function isBlockedIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] || '';
  if (!value || value === '::' || value === '::1') {
    return true;
  }
  if (value.startsWith('::ffff:')) {
    return isBlockedIpv4(value.slice('::ffff:'.length));
  }
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff')) {
    return true;
  }
  if (/^fe[89ab]/.test(value)) {
    return true;
  }
  if (value.startsWith('2001:db8:')) {
    return true;
  }
  const hextets = expandIpv6Hextets(value);
  if (hextets) {
    const embedded = embeddedTransitionIpv4(hextets);
    if (embedded && isBlockedIpv4(embedded)) {
      return true;
    }
  }
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIpv4(address);
  }
  if (family === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

export function assertCrawlableUrl(input: string | URL): URL {
  const url = input instanceof URL ? new URL(input.href) : new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Crawler only permits HTTP(S) URLs');
  }
  if (url.username || url.password) {
    throw new Error('Crawler URLs must not contain credentials');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Crawler only permits standard web ports');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    throw new Error('Crawler destination is not public');
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new Error('Crawler destination IP is not public');
  }
  return url;
}

export interface ApprovedAddress {
  address: string;
  family: 4 | 6;
}

export async function resolvePublicAddresses(url: URL): Promise<ApprovedAddress[]> {
  assertCrawlableUrl(url);
  if (isIP(url.hostname)) {
    const family = isIP(url.hostname) as 4 | 6;
    if (isBlockedAddress(url.hostname)) {
      throw new Error('Crawler destination IP is not public');
    }
    return [{ address: url.hostname, family }];
  }

  const resolved = await dns.lookup(url.hostname, { all: true, family: 0, order: 'verbatim' });
  if (resolved.length === 0) {
    throw new Error('Crawler destination did not resolve');
  }
  const unsafe = resolved.find(item => isBlockedAddress(item.address));
  if (unsafe) {
    throw new Error(`Crawler destination resolved to a non-public address (${unsafe.address})`);
  }
  return resolved.map(item => ({ address: item.address, family: item.family as 4 | 6 }));
}
