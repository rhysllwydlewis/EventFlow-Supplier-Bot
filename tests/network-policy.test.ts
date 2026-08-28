import { describe, expect, it } from 'vitest';
import { assertCrawlableUrl, isBlockedAddress } from '../src/crawler/network-policy.js';

describe('crawler network policy', () => {
  it('blocks loopback and private IPv4 ranges', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('allows ordinary public IPv4 addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });

  it('blocks local and Railway-private hostnames and unsafe schemes', () => {
    expect(() => assertCrawlableUrl('http://localhost/')).toThrow();
    expect(() => assertCrawlableUrl('http://eventflow.railway.internal/')).toThrow();
    expect(() => assertCrawlableUrl('file:///etc/passwd')).toThrow();
    expect(() => assertCrawlableUrl('http://example.com:6379')).toThrow();
  });

  it('allows standard public web URLs', () => {
    expect(assertCrawlableUrl('https://example.com/path').hostname).toBe('example.com');
  });

  it('decodes a private/metadata IPv4 embedded in a NAT64 address', () => {
    // 64:ff9b::/96 tunnels an IPv4 destination in its low 32 bits.
    expect(isBlockedAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isBlockedAddress('64:ff9b::c0a8:101')).toBe(true); // 192.168.1.1
  });

  it('allows a NAT64 address that embeds an ordinary public IPv4', () => {
    expect(isBlockedAddress('64:ff9b::0808:0808')).toBe(false); // 8.8.8.8
  });

  it('decodes a private/metadata IPv4 embedded in a 6to4 address', () => {
    // 2002:AABB:CCDD::/16 embeds the IPv4 AA.BB.CC.DD in the next 32 bits.
    expect(isBlockedAddress('2002:a9fe:a9fe::')).toBe(true); // 169.254.169.254
    expect(isBlockedAddress('2002:c0a8:101::1')).toBe(true); // 192.168.1.1
  });

  it('allows a 6to4 address that embeds an ordinary public IPv4', () => {
    expect(isBlockedAddress('2002:0808:0808::')).toBe(false); // 8.8.8.8
  });

  it('decodes the obfuscated client IPv4 embedded in a Teredo address', () => {
    // Well-known example from RFC 4380 / Wikipedia: this Teredo address
    // decodes (XOR 0xffffffff on the low 32 bits) to client IPv4
    // 192.0.2.45, which this policy already blocks as part of 192.0.0.0/16.
    expect(isBlockedAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true);
    // Obfuscated form of 10.0.0.1.
    expect(isBlockedAddress('2001:0:0:0:0:0:f5ff:fffe')).toBe(true);
  });

  it('allows a Teredo address whose decoded client IPv4 is ordinary and public', () => {
    // Obfuscated form of 8.8.8.8: NOT(8)=247=0xf7, NOT(8)=0xf7 repeated.
    expect(isBlockedAddress('2001:0:0:0:0:0:f7f7:f7f7')).toBe(false);
  });
});
