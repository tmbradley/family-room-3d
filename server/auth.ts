import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { prisma } from './db.js';
import { sha256, randomToken, humanCode, normalizeCode } from './util.js';

const domain = process.env.RP_ID || process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost';
export const rpID = domain;
export const origin = process.env.ORIGIN || (domain === 'localhost' ? 'http://localhost:3000' : `https://${domain}`);
const rpName = 'House Planner';
const secure = origin.startsWith('https://');

const SESSION_COOKIE = 'hp_session';
const CHALLENGE_COOKIE = 'hp_challenge';
const SESSION_DAYS = 30;
const DAY = 86_400_000;

export type AuthInfo =
  | { kind: 'user'; userId: number }
  | { kind: 'agent'; agentKeyId: number; scope: 'read' | 'propose' | 'admin' };

async function startSession(c: Context, userId: number) {
  const token = randomToken();
  await prisma.session.create({
    data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) },
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400,
  });
}

async function sessionUser(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(token) } });
  if (!s || s.expiresAt < new Date()) return null;
  // sliding expiry: refresh at most once a day
  if (Date.now() - +s.lastSeenAt > DAY) {
    await prisma.session.update({
      where: { id: s.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) },
    });
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
  }
  return s.userId;
}

async function agentFromHeader(c: Context) {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) return null;
  const key = await prisma.agentKey.findUnique({ where: { keyHash: sha256(h.slice(7).trim()) } });
  if (!key || key.revokedAt) return null;
  await prisma.agentKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key;
}

const scopeRank = { read: 0, propose: 1, admin: 2 } as const;

/** Allows Michael's session, or an agent key with at least `minScope`. */
export function requireAuth(minScope: keyof typeof scopeRank = 'read'): MiddlewareHandler<{ Variables: { auth: AuthInfo } }> {
  return async (c, next) => {
    const userId = await sessionUser(c);
    if (userId) { c.set('auth', { kind: 'user', userId }); return next(); }
    const key = await agentFromHeader(c);
    if (key) {
      if (scopeRank[key.scope] < scopeRank[minScope]) return c.json({ error: 'insufficient_scope', required: minScope }, 403);
      c.set('auth', { kind: 'agent', agentKeyId: key.id, scope: key.scope });
      return next();
    }
    return c.json({ error: 'unauthorized' }, 401);
  };
}

async function saveChallenge(c: Context, kind: 'register' | 'login', challenge: string, extra: { setupCodeId?: number; userId?: number } = {}) {
  const token = randomToken();
  await prisma.authChallenge.create({
    data: { tokenHash: sha256(token), kind, challenge, expiresAt: new Date(Date.now() + 5 * 60_000), ...extra },
  });
  setCookie(c, CHALLENGE_COOKIE, token, { httpOnly: true, secure, sameSite: 'Strict', path: '/auth', maxAge: 300 });
}

async function takeChallenge(c: Context, kind: 'register' | 'login') {
  const token = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: '/auth' });
  if (!token) return null;
  const ch = await prisma.authChallenge.findUnique({ where: { tokenHash: sha256(token) } });
  if (!ch) return null;
  await prisma.authChallenge.delete({ where: { id: ch.id } });
  if (ch.kind !== kind || ch.expiresAt < new Date()) return null;
  return ch;
}

async function validSetupCode(code: string | undefined) {
  if (!code) return null;
  const sc = await prisma.setupCode.findUnique({ where: { codeHash: sha256(normalizeCode(code)) } });
  if (!sc || sc.usedAt || sc.expiresAt < new Date()) return null;
  return sc;
}

async function makeRecoveryCodes(userId: number) {
  await prisma.recoveryCode.deleteMany({ where: { userId } });
  const codes = Array.from({ length: 10 }, () => humanCode(3, 4));
  await prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(normalizeCode(c)) })) });
  return codes;
}

export const auth = new Hono();

auth.get('/status', async (c) => {
  const passkeys = await prisma.passkey.count();
  const userId = await sessionUser(c);
  return c.json({ hasPasskeys: passkeys > 0, signedIn: !!userId, rpID });
});

// Register a passkey: first one needs the one-time setup code; more devices need a session.
auth.post('/register/options', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const userIdFromSession = await sessionUser(c);
  let setupCodeId: number | undefined;
  let user = userIdFromSession ? await prisma.user.findUnique({ where: { id: userIdFromSession } }) : null;
  if (!user) {
    const sc = await validSetupCode(body.setupCode);
    if (!sc) return c.json({ error: 'invalid_setup_code' }, 400);
    setupCodeId = sc.id;
    user = (await prisma.user.findFirst()) ?? (await prisma.user.create({ data: { name: 'Michael Bradley' } }));
  }
  const existing = await prisma.passkey.findMany({ where: { userId: user.id } });
  const options = await generateRegistrationOptions({
    rpName, rpID,
    userName: 'michael',
    userDisplayName: user.name,
    userID: new TextEncoder().encode(`user-${user.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: (p.transports?.split(',') as any) || undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  await saveChallenge(c, 'register', options.challenge, { setupCodeId, userId: user.id });
  return c.json(options);
});

auth.post('/register/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ch = await takeChallenge(c, 'register');
  if (!ch || !ch.userId) return c.json({ error: 'challenge_expired' }, 400);
  if (ch.setupCodeId) {
    const sc = await prisma.setupCode.findUnique({ where: { id: ch.setupCodeId } });
    if (!sc || sc.usedAt || sc.expiresAt < new Date()) return c.json({ error: 'invalid_setup_code' }, 400);
  }
  let v;
  try {
    v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID });
  } catch (e: any) {
    return c.json({ error: 'verification_failed', detail: String(e?.message ?? e) }, 400);
  }
  if (!v.verified || !v.registrationInfo) return c.json({ error: 'verification_failed' }, 400);
  const cred = v.registrationInfo.credential;
  await prisma.passkey.create({
    data: {
      userId: ch.userId,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports?.join(',') ?? null,
      deviceName: typeof body.deviceName === 'string' ? body.deviceName.slice(0, 120) : null,
    },
  });
  let recoveryCodes: string[] | undefined;
  if (ch.setupCodeId) {
    await prisma.setupCode.update({ where: { id: ch.setupCodeId }, data: { usedAt: new Date() } });
    recoveryCodes = await makeRecoveryCodes(ch.userId);
  }
  await startSession(c, ch.userId);
  return c.json({ ok: true, recoveryCodes });
});

auth.post('/login/options', async (c) => {
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  await saveChallenge(c, 'login', options.challenge);
  return c.json(options);
});

auth.post('/login/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ch = await takeChallenge(c, 'login');
  if (!ch) return c.json({ error: 'challenge_expired' }, 400);
  const pk = await prisma.passkey.findUnique({ where: { credentialId: String(body.response?.id ?? '') } });
  if (!pk) return c.json({ error: 'unknown_passkey' }, 400);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: pk.counter, transports: (pk.transports?.split(',') as any) || undefined },
    });
  } catch (e: any) {
    return c.json({ error: 'verification_failed', detail: String(e?.message ?? e) }, 400);
  }
  if (!v.verified) return c.json({ error: 'verification_failed' }, 400);
  await prisma.passkey.update({ where: { id: pk.id }, data: { counter: v.authenticationInfo.newCounter, lastUsedAt: new Date() } });
  await startSession(c, pk.userId);
  return c.json({ ok: true });
});

// Recovery code: single use, signs you in so you can register a new passkey.
auth.post('/recover', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = normalizeCode(String(body.code ?? ''));
  const rc = code ? await prisma.recoveryCode.findUnique({ where: { codeHash: sha256(code) } }) : null;
  if (!rc || rc.usedAt) return c.json({ error: 'invalid_code' }, 400);
  await prisma.recoveryCode.update({ where: { id: rc.id }, data: { usedAt: new Date() } });
  await startSession(c, rc.userId);
  const left = await prisma.recoveryCode.count({ where: { userId: rc.userId, usedAt: null } });
  return c.json({ ok: true, recoveryCodesLeft: left });
});

auth.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});
