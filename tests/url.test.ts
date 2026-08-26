import { describe, expect, it } from 'vitest';
import { canonicalDomain, canonicalizePublicHttpUrl } from '../src/utils/url.js';

describe('URL canonicalisation', () => {
  it('normalises common equivalent website URLs', () => {
    expect(canonicalDomain('https://www.Example.co.uk/')).toBe('example.co.uk');
    expect(canonicalDomain('https://example.co.uk/about#team')).toBe('example.co.uk');
  });

  it('removes default ports and fragments', () => {
    expect(canonicalizePublicHttpUrl('https://example.com:443/#x').href).toBe('https://example.com/');
  });

  it('rejects non-http protocols', () => {
    expect(() => canonicalizePublicHttpUrl('file:///etc/passwd')).toThrow('Only HTTP(S) URLs are supported');
  });
});
