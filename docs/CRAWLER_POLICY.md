# Crawler Policy

The crawler is public-web only.

- HTTP(S) only, standard web ports only.
- No credentials embedded in URLs.
- No login, CAPTCHA, paywall or access-control bypass.
- Block localhost, Railway-private/internal names, private/link-local/reserved IP space and cloud metadata destinations.
- Resolve DNS before each request and pin the connection to an approved resolved address; every redirect is independently revalidated.
- Default request timeout: 15 seconds.
- Default maximum page body: 2 MiB.
- Default maximum redirects: 5.
- Request identity: `EventFlowBot/0.1 (+https://event-flow.co.uk/bot)`.
- Site-level concurrency/rate policies will be enforced by the crawl queue before production crawling is enabled.
