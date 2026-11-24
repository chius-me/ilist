import { sha256Hex } from './auth';
import { base64UrlToBytes, bytesToBase64Url, timingSafeEqualBytes } from './shared/encoding';
import { deriveSessionHmacKey, legacyDigestHmacKey } from './shared/keys';
import type { Env } from './types';

const encoder = new TextEncoder();

interface AuthorizationPayload {
  v: 2;
  shareId: string;
  authRevision: number;
  exp: number;
}

async function signature(env: Env, payload: string): Promise<Uint8Array> {
  const key = await deriveSessionHmacKey(env.SESSION_SECRET, 'share-auth');
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

async function legacySignature(env: Env, payload: string): Promise<Uint8Array> {
  const key = await legacyDigestHmacKey(`ilist:share-authorization:v1:${env.SESSION_SECRET}`);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const chunk of cookie.split(';')) {
    const [key, ...value] = chunk.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

async function cookieName(token: string): Promise<string> {
  return `ilist_share_${(await sha256Hex(token)).slice(0, 16)}`;
}

function secureSuffix(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
}

function cookiePath(token: string): string {
  return `/s/${encodeURIComponent(token)}`;
}

export async function createShareAuthorization(
  env: Env,
  shareId: string,
  authRevision: number,
  expiresAt: number,
): Promise<string> {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify({
    v: 2,
    shareId,
    authRevision,
    exp: expiresAt,
  })));
  return `${encoded}.${bytesToBase64Url(await signature(env, encoded))}`;
}

export async function hasShareAuthorization(
  env: Env,
  request: Request,
  shareId: string,
  authRevision: number,
  token: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const value = cookieValue(request, await cookieName(token));
  if (!value) return false;
  try {
    const [encoded, encodedSignature, extra] = value.split('.');
    if (!encoded || !encodedSignature || extra !== undefined) return false;
    const actualSignature = base64UrlToBytes(encodedSignature);
    const matchesCurrent = timingSafeEqualBytes(await signature(env, encoded), actualSignature);
    const matchesLegacy = !matchesCurrent && timingSafeEqualBytes(await legacySignature(env, encoded), actualSignature);
    if (!matchesCurrent && !matchesLegacy) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as AuthorizationPayload;
    return payload.v === 2
      && payload.shareId === shareId
      && Number.isSafeInteger(payload.authRevision)
      && payload.authRevision === authRevision
      && Number.isSafeInteger(payload.exp)
      && payload.exp > now;
  } catch {
    return false;
  }
}

export async function shareAuthorizationCookie(
  request: Request,
  token: string,
  authorization: string,
  expiresAt: number,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const maxAge = Math.max(0, expiresAt - now);
  return `${await cookieName(token)}=${authorization}; Path=${cookiePath(token)}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureSuffix(request)}`;
}

export async function clearShareAuthorizationCookie(request: Request, token: string): Promise<string> {
  return `${await cookieName(token)}=; Path=${cookiePath(token)}; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix(request)}`;
}
