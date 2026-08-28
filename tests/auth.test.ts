import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginWithAdminKey, logout, requireCsrf, requireSession, sessionInfo } from '../src/control/auth.js';

const store = new Map<string, string>();

// vi.mock calls are hoisted above these imports by Vitest, so auth.ts's
// `import { getRedis } from '../lib/redis.js'` resolves to this in-memory
// fake rather than a real ioredis client -- this repo has no Mongo/Redis
// test harness, so a fake store is what makes real behavioral coverage of
// the revocation flow possible at all.
vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    exists: async (key: string) => (store.has(key) ? 1 : 0),
  }),
}));

function mockResponse(): Response & { statusCode: number; body: unknown; headers: Record<string, string> } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown; headers: Record<string, string> };
}

function mockRequest(cookie?: string, headers: Record<string, string> = {}, body: unknown = {}): Request {
  return {
    headers: { cookie, ...headers },
    body,
    get(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as unknown as Request;
}

function extractCookieValue(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]!.split('=').slice(1).join('=');
}

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = mockResponse();
  loginWithAdminKey(mockRequest(undefined, {}, { key: 'test-control-admin-key-0000000000' }), loginRes);
  const cookie = `ef_supplier_bot_session=${extractCookieValue(loginRes.headers['Set-Cookie']!)}`;
  const csrfToken = (loginRes.body as { csrfToken: string }).csrfToken;
  return { cookie, csrfToken };
}

describe('control panel session auth', () => {
  beforeEach(() => {
    store.clear();
  });

  it('rejects an invalid admin key', () => {
    const res = mockResponse();
    loginWithAdminKey(mockRequest(undefined, {}, { key: 'wrong' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('issues a session that requireSession and sessionInfo accept', async () => {
    const { cookie } = await login();
    const next = vi.fn();
    const req = mockRequest(cookie);
    const res = mockResponse();
    await requireSession(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);

    const infoRes = mockResponse();
    await sessionInfo(mockRequest(cookie), infoRes);
    expect((infoRes.body as { authenticated: boolean }).authenticated).toBe(true);
  });

  it('requires a matching CSRF token for state-changing requests', async () => {
    const { cookie, csrfToken } = await login();

    const rejected = mockResponse();
    await requireCsrf(mockRequest(cookie, { 'x-csrf-token': 'wrong-token' }), rejected, vi.fn());
    expect(rejected.statusCode).toBe(403);

    const next = vi.fn();
    const accepted = mockResponse();
    await requireCsrf(mockRequest(cookie, { 'x-csrf-token': csrfToken }), accepted, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('revokes a session on logout so a copied cookie stops working immediately', async () => {
    // Logout alone clearing the client's cookie can't stop a *copy* of the
    // token (already exfiltrated, or cached by a proxy) from continuing to
    // work for the rest of its 12h lifetime -- the server-side denylist is
    // what actually invalidates it.
    const { cookie, csrfToken } = await login();

    const logoutRes = mockResponse();
    await logout(mockRequest(cookie, { 'x-csrf-token': csrfToken }), logoutRes);
    expect((logoutRes.body as { authenticated: boolean }).authenticated).toBe(false);

    // The original cookie -- a copy an attacker might have captured before
    // logout -- must now be rejected even though its signature and expiry
    // both still check out.
    const next = vi.fn();
    const res = mockResponse();
    await requireSession(mockRequest(cookie), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('sets the Secure cookie flag outside of development, not only in production', () => {
    // Fails closed: every environment except the one named exception
    // (development) gets Secure, rather than requiring every safe
    // environment to be added to an allow-list before it's covered.
    expect(process.env.NODE_ENV).toBe('test');
    const res = mockResponse();
    loginWithAdminKey(mockRequest(undefined, {}, { key: 'test-control-admin-key-0000000000' }), res);
    expect(res.headers['Set-Cookie']).toContain('; Secure');
  });

  it('does not let one session revocation affect a different, still-valid session', async () => {
    const first = await login();
    const second = await login();

    await logout(mockRequest(first.cookie, { 'x-csrf-token': first.csrfToken }), mockResponse());

    const next = vi.fn();
    const res = mockResponse();
    await requireSession(mockRequest(second.cookie), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
