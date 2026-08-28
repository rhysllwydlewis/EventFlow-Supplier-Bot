import { describe, expect, it } from 'vitest';
import { parseAuthority, resolveValidatedTarget } from '../src/crawler/browser-network-proxy.js';

describe('SSRF-safe browser proxy', () => {
  describe('parseAuthority', () => {
    it('parses a plain host:port CONNECT target', () => {
      expect(parseAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 });
    });

    it('parses a bracketed IPv6 CONNECT target', () => {
      expect(parseAuthority('[2001:4860:4860::8888]:443')).toEqual({
        host: '2001:4860:4860::8888',
        port: 443,
      });
    });

    it('rejects a malformed target', () => {
      expect(parseAuthority('not-an-authority')).toBeNull();
      expect(parseAuthority('')).toBeNull();
    });
  });

  describe('resolveValidatedTarget', () => {
    it('resolves an ordinary public IPv4 literal', async () => {
      const resolved = await resolveValidatedTarget('8.8.8.8', 443);
      expect(resolved).toEqual({ address: '8.8.8.8', family: 4 });
    });

    it('blocks loopback destinations', async () => {
      expect(await resolveValidatedTarget('127.0.0.1', 443)).toBeNull();
      expect(await resolveValidatedTarget('localhost', 443)).toBeNull();
    });

    it('blocks private and link-local IPv4 ranges', async () => {
      expect(await resolveValidatedTarget('10.1.2.3', 443)).toBeNull();
      expect(await resolveValidatedTarget('192.168.1.1', 443)).toBeNull();
      expect(await resolveValidatedTarget('169.254.169.254', 443)).toBeNull();
    });

    it('blocks IPv6 loopback and unique-local destinations', async () => {
      expect(await resolveValidatedTarget('::1', 443)).toBeNull();
      expect(await resolveValidatedTarget('fd00::1', 443)).toBeNull();
    });

    it('blocks non-standard ports even for an otherwise-public host', async () => {
      expect(await resolveValidatedTarget('8.8.8.8', 6379)).toBeNull();
    });
  });
});
