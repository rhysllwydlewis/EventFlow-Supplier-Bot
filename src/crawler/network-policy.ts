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
