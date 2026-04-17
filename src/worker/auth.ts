import { HttpError } from './http';
import type { AdminUser, Env } from './types';

const COOKIE_NAME = 'ilist_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface AdminSession {
  id: string;
  user: AdminUser;
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function hashPassword(password: string): Promise<string> {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return `pbkdf2:${iterations}:${bytesToHex(salt)}:${bytesToHex(bits)}`;
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [scheme, iterationsText, saltHex, hashHex] = storedHash.split(':');
  if (scheme !== 'pbkdf2') throw new HttpError(500, 'Unsupported password hash format');

  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000) {
    throw new HttpError(500, 'Invalid password hash parameters');
  }

  const salt = hexToBytes(saltHex);
  const expectedLength = hashHex.length / 2;
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    expectedLength * 8,
  );

  return timingSafeEqualHex(bytesToHex(bits), hashHex.toLowerCase());
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

export async function createSession(env: Env): Promise<{ token: string; expiresAt: number }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(random);
  const id = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + sessionTtl(env);

  await env.DB.prepare(`INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)`)
    .bind(id, expiresAt, now)
    .run();

  return { token, expiresAt };
}

export async function deleteSession(env: Env, request: Request): Promise<void> {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return;
  const id = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
}

export async function currentAdminSession(env: Env, request: Request): Promise<AdminSession | null> {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;

  const id = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare(`SELECT id FROM sessions WHERE id = ? AND expires_at > ?`)
    .bind(id, now)
    .first<{ id: string }>();
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
