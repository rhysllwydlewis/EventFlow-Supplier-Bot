# Crawler Policy

The crawler is public-web only and uses lightweight HTTP first. Playwright/Chromium is a bounded fallback only when the static site appears to be a JavaScript app shell or contains too little usable business content.

- HTTP(S) only, standard web ports only.
- No credentials embedded in URLs.
- No login, CAPTCHA, paywall or access-control bypass.
- Block localhost, Railway-private/internal names, private/link-local/reserved IP space and cloud metadata destinations.
- Resolve DNS before HTTP requests and validate every browser request against the same public-network policy.
- Honor robots.txt for both static and browser crawling; sitemap discovery remains optional.
- Default static request timeout: 15 seconds.
- Default browser navigation timeout: 30 seconds.
- Static maximum page body: 2 MiB.
- Browser-rendered HTML maximum: 2 MiB per page.
- Browser fallback defaults to at most 4 useful pages and concurrency 1.
- Browser downloads, service workers, images, media, fonts, WebSockets and EventSource traffic are blocked where applicable.
- Chromium sandboxing is required by default; disabling it requires an explicit deployment variable.
- Browser crawling has its own daily absolute safety ceiling in addition to the normal crawl ceiling.
- Request identity: `EventFlowBot/0.1 (+https://event-flow.co.uk/bot)`.
