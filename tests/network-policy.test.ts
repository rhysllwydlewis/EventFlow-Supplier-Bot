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
});
