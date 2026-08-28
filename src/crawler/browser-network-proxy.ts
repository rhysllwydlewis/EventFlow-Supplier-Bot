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
  let upstream: net.Socket | null = null;
  // Must be attached synchronously, before any await: an 'error' event with
  // no listener crashes the whole process, and the client can disconnect or
  // error while resolveValidatedTarget's DNS lookup is still in flight below,
  // before the .then() callback has a chance to attach its own handlers.
  clientSocket.on('error', () => upstream?.destroy());
  clientSocket.on('close', () => upstream?.destroy());

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
      upstream = net.connect({ host: resolved.address, port: authority.port, family: resolved.family });
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream?.write(head);
        if (upstream) {
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        }
      });
      upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstream?.destroy());
      clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => clientSocket.destroy());
      // Either side ending -- cleanly or with an error -- must tear down the
      // other, or a client that vanishes mid-tunnel leaks an open upstream
      // connection to the target site indefinitely.
      upstream.on('error', () => clientSocket.destroy());
      upstream.on('close', () => clientSocket.destroy());
    })
    .catch(() => clientSocket.destroy());
}

function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  let upstreamReq: http.ClientRequest | null = null;
  // Same reasoning as handleConnect: attached before any await so a client
  // abort during the DNS-validation window can't crash the process.
  req.on('error', () => upstreamReq?.destroy());
  res.on('error', () => upstreamReq?.destroy());

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

    upstreamReq = http.request(
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
    upstreamReq.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstreamReq?.destroy());
    upstreamReq.on('error', () => res.destroy());
    req.pipe(upstreamReq);
  })();
}

export async function startSsrfSafeProxy(): Promise<SsrfSafeProxy> {
  const server = http.createServer(handleHttpRequest);
  server.on('connect', handleConnect);

  // server.close() alone only stops accepting *new* connections and waits
  // for existing ones to end on their own -- a CONNECT tunnel still open (or
  // stuck) when the crawl finishes would otherwise keep close() from ever
  // resolving. Track every inbound connection and force them closed instead
  // of waiting for a graceful drain that may never come.
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
