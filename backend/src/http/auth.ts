/**
 * Mock authentication — deliberately simple, but STATELESS.
 *
 * "Login" = type a name; we upsert a users row and hand back a signed token
 * (HMAC of the user's id/name/admin flag). Any API replica can verify the
 * token with the shared secret, without a session store and without a DB
 * lookup per request. That's the property that matters for horizontal
 * scaling; real auth (passwords/OAuth/JWT expiry) is out of scope.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SECRET = process.env.AUTH_SECRET ?? 'dev-only-secret-change-me';

export interface AuthUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueToken(user: AuthUser): string {
  const payload = Buffer.from(JSON.stringify(user)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): AuthUser | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthUser;
  } catch {
    return null;
  }
}

/** Attaches req.user if a valid Bearer token is present. Never rejects. */
export function parseAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    const user = verifyToken(header.slice(7));
    if (user) req.user = user;
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Log in first.' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only.' });
    return;
  }
  next();
}
