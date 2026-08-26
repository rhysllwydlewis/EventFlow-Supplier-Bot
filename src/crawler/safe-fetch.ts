import * as http from 'node:http';
import * as https from 'node:https';
import { assertCrawlableUrl, resolvePublicAddresses } from './network-policy.js';

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: string[];
  userAgent?: string;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  redirects: string[];
}

export class SafeFetchError extends Error {
  readonly kind: 'http';
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SafeFetchError';
    this.kind = 'http';
    this.status = status;
  }
}

const DEFAULT_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

function requestPinned(
  url: URL,
  address: string,
  family: 4 | 6,
  options: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes' | 'userAgent'>>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; bytes: number }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const requestFn = secure ? https.request : http.request;
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: address,
      family,
      port,
      method: 'GET',
      path: `${url.pathname || '/'}${url.search}`,
      headers: {
        Host: url.host,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        'User-Agent': options.userAgent,
      },
      maxHeaderSize: 32 * 1024,
      ...(secure ? { servername: url.hostname, rejectUnauthorized: true } : {}),
    };

    const req = requestFn(requestOptions, response => {
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        response.destroy();
        reject(new Error(`Crawler response exceeds ${options.maxBytes} byte limit`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > options.maxBytes) {
          response.destroy(new Error(`Crawler response exceeds ${options.maxBytes} byte limit`));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          bytes,
        });
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`Crawler request timed out after ${options.timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function safeFetchText(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_CONTENT_TYPES;
  const userAgent = options.userAgent ?? 'EventFlowBot/0.1 (+https://event-flow.co.uk/bot)';
  const redirects: string[] = [];

  let url = assertCrawlableUrl(input);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const addresses = await resolvePublicAddresses(url);
    const pinned = addresses[0];
    if (!pinned) {
      throw new Error('Crawler destination has no approved address');
    }

    const response = await requestPinned(url, pinned.address, pinned.family, {
      timeoutMs,
      maxBytes,
      userAgent,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Crawler received redirect ${response.status} without Location header`);
      }
      if (redirectCount >= maxRedirects) {
        throw new Error(`Crawler exceeded ${maxRedirects} redirects`);
      }
      redirects.push(url.href);
      url = assertCrawlableUrl(new URL(location, url));
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SafeFetchError(`Crawler received HTTP ${response.status}`, response.status);
    }

    const contentType = String(response.headers['content-type'] || '').split(';')[0]?.trim().toLowerCase() || '';
    if (!allowedContentTypes.some(type => contentType === type || contentType.startsWith(`${type};`))) {
      throw new Error(`Crawler rejected content type: ${contentType || 'unknown'}`);
    }

    return {
      finalUrl: url.href,
      status: response.status,
      contentType,
      body: response.body.toString('utf8'),
      bytes: response.bytes,
      redirects,
    };
  }

  throw new Error('Crawler redirect loop');
}
