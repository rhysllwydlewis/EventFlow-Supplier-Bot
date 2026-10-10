import { describe, expect, it, vi } from 'vitest';
import { ControlApiError, ControlClient, assertSafeControlUrl } from '../src/operator/client.js';

function response(status: number, body: unknown, headers: Record<string, string | string[]> = {}): Response {
  const res = new Response(status === 204 ? null : JSON.stringify(body), { status });
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) res.headers.append(name, item);
  }
  return res;
}

const loginOk = () =>
  response(200, { authenticated: true, csrfToken: 'csrf-123' }, { 'set-cookie': ['ef_supplier_bot_session=tok.sig; Path=/; HttpOnly; Secure'] });

describe('ControlClient', () => {
  it('JSON-encodes an admin key containing quotes and backslashes', async () => {
    const key = 'ab"cd\\ef-0123456789012345';
    const fetchImpl = vi.fn(async () => loginOk());
    await new ControlClient('https://bot.example/', key, fetchImpl as unknown as typeof fetch).login();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bot.example/api/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({ key });
  });

  it('sends the session cookie on reads and the CSRF header on writes', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginOk();
      if (url.endsWith('/dismiss')) return response(204, null);
      if (url.endsWith('/approve')) return response(200, { applied: true, resultDetail: 'Discovery enabled.' });
      return response(200, { items: [] });
    });
    const client = new ControlClient('https://bot.example', 'k'.repeat(26), fetchImpl as unknown as typeof fetch);
    await client.login();
    await client.pendingRecommendations();
    expect(await client.dismiss('id 1')).toEqual({ ok: true, httpStatus: 204, detail: '' });
    expect(await client.approve('id2')).toEqual({ ok: true, httpStatus: 200, detail: 'Discovery enabled.' });

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const read = calls.find(([url]) => url.includes('/api/agent/recommendations?'));
    expect(new Headers(read?.[1].headers).get('cookie')).toBe('ef_supplier_bot_session=tok.sig');
    const dismiss = calls.find(([url]) => url.endsWith('/dismiss'));
    expect(dismiss?.[0]).toContain('/recommendations/id%201/dismiss');
    expect(new Headers(dismiss?.[1].headers).get('x-csrf-token')).toBe('csrf-123');
  });

  it('reports a rejected key distinctly from other login failures', async () => {
    const rejected = new ControlClient('https://bot.example', 'x', (async () => response(401, { error: 'Invalid credentials' })) as unknown as typeof fetch);
    await expect(rejected.login()).rejects.toMatchObject({ httpStatus: 401, message: expect.stringContaining('rotated') });
    const broken = new ControlClient('https://bot.example', 'x', (async () => response(500, {})) as unknown as typeof fetch);
    await expect(broken.login()).rejects.toBeInstanceOf(ControlApiError);
  });

  it('surfaces a 409 on approve as a not-ok result instead of throwing', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/auth/login') ? loginOk() : response(409, { error: 'No longer valid: campaign_not_found' }),
    );
    const client = new ControlClient('https://bot.example', 'k', fetchImpl as unknown as typeof fetch);
    await client.login();
    expect(await client.approve('a')).toEqual({ ok: false, httpStatus: 409, detail: 'No longer valid: campaign_not_found' });
  });

  it('probes without credentials and survives network errors', async () => {
    const down = new ControlClient('https://bot.example', 'k', (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(await down.probe('/health')).toMatchObject({ ok: false, httpStatus: 0 });
  });
});

describe('assertSafeControlUrl', () => {
  it.each(['https://supplier-bot-control-production.up.railway.app', 'http://localhost:3000', 'http://127.0.0.1:8080'])('accepts %s', url => {
    expect(() => assertSafeControlUrl(url)).not.toThrow();
  });

  it.each([
    'http://bot.example',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'ftp://bot.example',
    'https://user:pass@bot.example',
    'not a url',
  ])('rejects %s', url => {
    expect(() => assertSafeControlUrl(url)).toThrow();
  });
});
