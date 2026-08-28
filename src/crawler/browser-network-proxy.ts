import * as http from 'node:http';
import * as net from 'node:net';
import { assertCrawlableUrl, resolvePublicAddresses, type ApprovedAddress } from './network-policy.js';

// Chromium's own DNS resolver runs independently of any check Node performs
// beforehand -- context.route() can validate a request's URL, but by the time
// Chromium actually opens the socket it re-resolves the hostname itself, so a
// short-TTL DNS record can point at a public IP for the check and a private
// one moments later (DNS rebinding). The only way to make the IP Chromium
// actually connects to the same one Node just validated is to put a Node
// process in the middle of every TCP connection: this proxy resolves and
// validates each destination immediately before opening the upstream socket,
// then hands that literal connection to the browser, exactly like
// safe-fetch.ts already does for the static crawl path.
const TUNNEL_IDLE_TIMEOUT_MS = 60_000;

export interface SsrfSafeProxy {
  port: number;
  close: () => Promise<void>;
}

export function parseAuthority(target: string): { host: string; port: number } | null {
  const bracketed = target.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) {
    const port = Number(bracketed[2]);
    return bracketed[1] ? { host: bracketed[1], port } : null;
  }
  const plain = target.match(/^([^:]+):(\d+)$/);
  if (plain) {
    const port = Number(plain[2]);
    return plain[1] ? { host: plain[1], port } : null;
  }
  return null;
}

function authorityUrl(host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `https://${bracketed}:${port}/`;
}

export async function resolveValidatedTarget(host: string, port: number): Promise<ApprovedAddress | null> {
  try {
    const url = assertCrawlableUrl(authorityUrl(host, port));
    const addresses = await resolvePublicAddresses(url);
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

function handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
  const authority = parseAuthority(req.url || '');
  if (!authority) {
    clientSocket.destroy();
    return;
  }

  void resolveValidatedTarget(authority.host, authority.port)
    .then(resolved => {
      if (!resolved) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const upstream = net.connect({ host: resolved.address, port: authority.port, family: resolved.family });
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstream.destroy());
      clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => clientSocket.destroy());
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    })
    .catch(() => clientSocket.destroy());
}

function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    let url: URL;
    try {
      url = assertCrawlableUrl(req.url || '');
    } catch {
      res.writeHead(502).end();
      return;
    }

    const addresses = await resolvePublicAddresses(url).catch(() => null);
    const pinned = addresses?.[0];
    if (!pinned) {
      res.writeHead(502).end();
      return;
    }

    const upstreamReq = http.request(
      {
        hostname: pinned.address,
        family: pinned.family,
        port: url.port ? Number(url.port) : 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, host: url.host },
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstreamReq.destroy());
    upstreamReq.on('error', () => res.destroy());
    req.pipe(upstreamReq);
  })();
}

export async function startSsrfSafeProxy(): Promise<SsrfSafeProxy> {
  const server = http.createServer(handleHttpRequest);
  server.on('connect', handleConnect);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
