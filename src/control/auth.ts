import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { getRedis } from '../lib/redis.js';

const COOKIE_NAME = 'ef_supplier_bot_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  v: 1;
  exp: number;
  csrf: string;
  sid: string;
}

function revokedSessionKey(sid: string): string {
  return `eventflow-supplier-bot:revoked-session:${sid}`;
}

// Sessions are stateless HMAC tokens with no server-side record, so a token
// that has been signed stays valid for its full lifetime by construction --
// logout alone (clearing the client's cookie) can't stop a copy of that
// token from still working. This denylist is the server-side override: a
// revoked session id is rejected by parseSession even while its signature
// and expiry both still check out.
async function revokeSession(sid: string, exp: number): Promise<void> {
  const ttlSeconds = Math.ceil((exp - Date.now()) / 1000);
  if (ttlSeconds <= 0) return;
  await getRedis().set(revokedSessionKey(sid), '1', 'EX', ttlSeconds);
}

async function isSessionRevoked(sid: string): Promise<boolean> {
  const value = await getRedis().exists(revokedSessionKey(sid));
  return value === 1;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signature(payload: string): string {
  return createHmac('sha256', env.CONTROL_SESSION_SECRET).update(payload).digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce<Record<string, string>>((acc, part) => {
    const index = part.indexOf('=');
    if (index <= 0) {
      return acc;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

async function parseSession(req: Request): Promise<SessionPayload | null> {
  const token = readCookies(req)[COOKIE_NAME];
  if (!token) {
    return null;
  }
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart || !constantTimeEqual(signature(payloadPart), signaturePart)) {
    return null;
  }
  let payload: SessionPayload;
  try {
    // JSON.parse succeeds (without throwing) for any valid JSON value, not
    // just objects -- a decoded payload of "null" or "42" would otherwise
    // reach the field checks below and throw when a property is read off a
    // non-object, outside this try/catch. Both the parse and the shape
    // check have to be covered by the same catch.
    const parsed: unknown = JSON.parse(decode(payloadPart));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    payload = parsed as SessionPayload;
    if (payload.v !== 1 || !payload.csrf || !payload.sid || !Number.isFinite(payload.exp) || payload.exp < Date.now()) {
      return null;
    }
  } catch {
    return null;
  }
  if (await isSessionRevoked(payload.sid)) {
    return null;
  }
  return payload;
}

// NODE_ENV is a closed enum validated at process startup (see config/env.ts),
// so this can never see an unexpected string -- but the check still fails
// closed by construction: development is the one named exception, and every
// other current or future environment value (including 'test') keeps the
// cookie Secure rather than needing to be added to an allow-list first.
function secureCookieFlag(): string {
  return env.NODE_ENV !== 'development' ? '; Secure' : '';
}

export function loginWithAdminKey(req: Request, res: Response): void {
  const candidate = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!constantTimeEqual(candidate, env.CONTROL_ADMIN_KEY)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const payload: SessionPayload = {
    v: 1,
    exp: Date.now() + SESSION_LIFETIME_MS,
    csrf: randomBytes(24).toString('base64url'),
    sid: randomBytes(16).toString('hex'),
  };
  const encoded = encode(JSON.stringify(payload));
  const token = `${encoded}.${signature(encoded)}`;
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secureCookieFlag()}`,
  );
  res.json({ authenticated: true, csrfToken: payload.csrf, expiresAt: new Date(payload.exp).toISOString() });
}

export async function logout(req: Request, res: Response): Promise<void> {
  // requireSession and requireCsrf both run before this handler on the
  // logout route and already parsed (and Redis-checked) the session,
  // storing it on res.locals -- re-parsing here would mean a third
  // signature check and Redis round trip for what is already known.
  const session = (res.locals.session as SessionPayload | undefined) ?? (await parseSession(req));
  if (session) {
    await revokeSession(session.sid, session.exp);
  }
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieFlag()}`);
  res.json({ authenticated: false });
}

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await parseSession(req);
  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  res.locals.session = session;
  next();
}

export async function requireCsrf(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await parseSession(req);
  const supplied = req.get('x-csrf-token') || '';
  if (!session || !constantTimeEqual(supplied, session.csrf)) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }
  res.locals.session = session;
  next();
}

export async function sessionInfo(req: Request, res: Response): Promise<void> {
  const session = await parseSession(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, csrfToken: session.csrf, expiresAt: new Date(session.exp).toISOString() });
}
