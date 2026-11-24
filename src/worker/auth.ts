import { deleteSessionById, findActiveSession, insertSession } from './db/sessions';
import { HttpError } from './http';
import { bytesToHex, hexToBytes, timingSafeEqualStrings } from './shared/encoding';
import { deriveSessionHmacKey } from './shared/keys';
import type { AdminUser, Env } from './types';
import {
  formatPasswordHash,
  parsePasswordHash,
  passwordFitsPolicy,
  PBKDF2_SHA256_ITERATIONS,
  PASSWORD_HASH_BYTES,
  PASSWORD_SALT_BYTES,
} from '../../scripts/lib/password-policy.mjs';

const COOKIE_NAME = 'ilist_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();

export interface AdminSession {
  id: string;
  user: AdminUser;
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function sessionIdFromToken(env: Env, token: string): Promise<string> {
  const key = await deriveSessionHmacKey(env.SESSION_SECRET, 'admin-session');
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(token)));
}

async function legacySessionIdFromToken(env: Env, token: string): Promise<string> {
  return sha256Hex(`${env.SESSION_SECRET}:${token}`);
}

export async function hashPassword(password: string): Promise<string> {
  if (!passwordFitsPolicy(password)) throw new RangeError('Password exceeds the supported size');
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_SHA256_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    PASSWORD_HASH_BYTES * 8,
  );
  return formatPasswordHash(bytesToHex(salt), bytesToHex(bits));
}

export interface PasswordVerification {
  valid: boolean;
  needsUpgrade: boolean;
}

const INVALID_PASSWORD_VERIFICATION: PasswordVerification = { valid: false, needsUpgrade: false };

export async function verifyPasswordDetailed(password: string, storedHash: string): Promise<PasswordVerification> {
  if (!passwordFitsPolicy(password)) return INVALID_PASSWORD_VERIFICATION;
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) return INVALID_PASSWORD_VERIFICATION;

  try {
    const salt = hexToBytes(parsed.saltHex);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: parsed.iterations, hash: 'SHA-256' },
      keyMaterial,
      PASSWORD_HASH_BYTES * 8,
    );
    const valid = timingSafeEqualStrings(bytesToHex(bits), parsed.hashHex);
    return { valid, needsUpgrade: valid && parsed.needsUpgrade };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'password_verify_error',
      message: error instanceof Error ? error.message : String(error),
    }));
    return INVALID_PASSWORD_VERIFICATION;
  }
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return (await verifyPasswordDetailed(password, storedHash)).valid;
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;

  for (const chunk of cookie.split(';')) {
    const [rawKey, ...rawValue] = chunk.trim().split('=');
    if (rawKey === name) return rawValue.join('=');
  }

  return null;
}

function sessionTtl(env: Env): number {
  const parsed = Number(env.SESSION_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

export async function createSession(env: Env): Promise<{ id: string; token: string; expiresAt: number }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(random);
  const id = await sessionIdFromToken(env, token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + sessionTtl(env);

  await insertSession(env.DB, id, expiresAt, now);

  return { id, token, expiresAt };
}

export async function deleteSession(
  env: Env,
  request: Request,
  options: { beforeDelete?: (sessionId: string) => Promise<void> } = {},
): Promise<string | null> {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  const [id, legacyId] = await Promise.all([
    sessionIdFromToken(env, token),
    legacySessionIdFromToken(env, token),
  ]);
  const existing = (await env.DB.prepare('SELECT id FROM sessions WHERE id IN (?, ?)')
    .bind(id, legacyId)
    .first<{ id: string }>()) ?? null;
  if (existing) {
    await options.beforeDelete?.(existing.id);
    await deleteSessionById(env.DB, existing.id);
    return existing.id;
  }
  return id;
}

export async function currentAdminSession(env: Env, request: Request): Promise<AdminSession | null> {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  const id = await sessionIdFromToken(env, token);
  const session = await findActiveSession(env.DB, id, now)
    ?? await findActiveSession(env.DB, await legacySessionIdFromToken(env, token), now);
  if (!session) return null;

  return {
    id: session.id,
    user: { username: env.ADMIN_USERNAME || 'admin' },
  };
}

export async function currentUser(env: Env, request: Request): Promise<AdminUser | null> {
  return (await currentAdminSession(env, request))?.user ?? null;
}

export async function requireAdminSession(env: Env, request: Request): Promise<AdminSession> {
  const session = await currentAdminSession(env, request);
  if (!session) throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required');
  return session;
}

export async function requireAdmin(env: Env, request: Request): Promise<AdminUser> {
  return (await requireAdminSession(env, request)).user;
}

function secureCookieSuffix(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
}

export function sessionCookie(request: Request, token: string, expiresAt: number): string {
  const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookieSuffix(request)}`;
}

export function clearSessionCookie(request: Request): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix(request)}`;
}
