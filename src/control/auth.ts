import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

const COOKIE_NAME = 'ef_supplier_bot_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  v: 1;
  exp: number;
  csrf: string;
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

function parseSession(req: Request): SessionPayload | null {
  const token = readCookies(req)[COOKIE_NAME];
  if (!token) {
    return null;
  }
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart || !constantTimeEqual(signature(payloadPart), signaturePart)) {
    return null;
  }
  try {
    const payload = JSON.parse(decode(payloadPart)) as SessionPayload;
    if (payload.v !== 1 || !payload.csrf || !Number.isFinite(payload.exp) || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
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
  };
  const encoded = encode(JSON.stringify(payload));
  const token = `${encoded}.${signature(encoded)}`;
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secure}`,
  );
  res.json({ authenticated: true, csrfToken: payload.csrf, expiresAt: new Date(payload.exp).toISOString() });
}

export function logout(_req: Request, res: Response): void {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  res.json({ authenticated: false });
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = parseSession(req);
  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  res.locals.session = session;
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const session = parseSession(req);
  const supplied = req.get('x-csrf-token') || '';
  if (!session || !constantTimeEqual(supplied, session.csrf)) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }
  res.locals.session = session;
  next();
}

export function sessionInfo(req: Request, res: Response): void {
  const session = parseSession(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, csrfToken: session.csrf, expiresAt: new Date(session.exp).toISOString() });
}
