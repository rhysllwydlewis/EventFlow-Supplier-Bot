import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPinned } from '../src/crawler/safe-fetch.js';

describe('requestPinned', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>(resolve => server?.close(() => resolve()));
    server = null;
  });

  it('enforces an absolute deadline even while the server keeps the connection active', async () => {
    // req.setTimeout is an *idle* timeout that resets on every byte -- a
    // server that drips output faster than the idle timeout, but slower
    // than a reasonable total response time, could hold the connection open
    // indefinitely under the old idle-only timer. Here the server writes a
    // byte every 60ms (well under the 250ms idle window) for far longer than
    // the 250ms absolute deadline, so the request must still be cut off
    // around 250ms rather than continuing forever.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const interval = setInterval(() => res.write('a'), 60);
      res.socket?.on('close', () => clearInterval(interval));
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const start = Date.now();
    await expect(
      requestPinned(new URL(`http://127.0.0.1:${port}/`), '127.0.0.1', 4, {
        timeoutMs: 250,
        maxBytes: 1024,
        userAgent: 'test-agent',
      }),
    ).rejects.toThrow(/timed out after 250ms/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(1000);
  });

  it('resolves normally for a fast response', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const result = await requestPinned(new URL(`http://127.0.0.1:${port}/`), '127.0.0.1', 4, {
      timeoutMs: 5000,
      maxBytes: 1024,
      userAgent: 'test-agent',
    });
    expect(result.status).toBe(200);
    expect(result.body.toString('utf8')).toBe('hello');
  });
});
