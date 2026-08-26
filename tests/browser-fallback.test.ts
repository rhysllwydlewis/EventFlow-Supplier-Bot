import { describe, expect, it } from 'vitest';
import { assessBrowserFallback } from '../src/crawler/browser-fallback.js';

function extraction(text: string, facts = false) {
  return {
    emails: facts ? ['hello@example.com'] : [],
    phones: [],
    advertisedPrices: [],
    jsonLd: [],
    pageText: [{ url: 'https://example.com/', text }],
  };
}

describe('browser fallback detection', () => {
  it('escalates sparse JavaScript app shells', () => {
    const decision = assessBrowserFallback({
      rootUrl: 'https://example.com',
      finalRootUrl: 'https://example.com/',
      failures: [],
      pages: [{
        url: 'https://example.com/', contentType: 'text/html', bytes: 120,
        html: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
      }],
    }, extraction('Loading'));
    expect(decision.required).toBe(true);
    expect(decision.reason).toBe('javascript_app_shell_with_sparse_static_content');
  });

  it('keeps useful static supplier sites on the HTTP path', () => {
    const decision = assessBrowserFallback({
      rootUrl: 'https://example.com',
      finalRootUrl: 'https://example.com/',
      failures: [],
      pages: [{
        url: 'https://example.com/', contentType: 'text/html', bytes: 5000,
        html: '<html><body><h1>Example Manor</h1><p>Wedding venue in Cardiff.</p></body></html>',
      }, {
        url: 'https://example.com/contact', contentType: 'text/html', bytes: 1000,
        html: '<p>hello@example.com</p>',
      }],
    }, extraction('Example Manor wedding venue in Cardiff. '.repeat(30), true));
    expect(decision.required).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it('does not escalate a short static page when a public business fact is already present', () => {
    const decision = assessBrowserFallback({
      rootUrl: 'https://example.com',
      finalRootUrl: 'https://example.com/',
      failures: [],
      pages: [{
        url: 'https://example.com/', contentType: 'text/html', bytes: 800,
        html: '<html><body><script src="/app.js"></script><p>Call us</p></body></html>',
      }],
    }, extraction('Call us', true));
    expect(decision.required).toBe(false);
  });
});
