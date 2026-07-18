import { sha256Hex } from './auth';
import type { Env } from './types';

const encoder = new TextEncoder();

interface AuthorizationPayload {
  v: 1;
  shareId: string;
  exp: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const key = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`ilist:share-authorization:v1:${env.SESSION_SECRET}`),
  );
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signature(env: Env, payload: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload)));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
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

export async function createShareAuthorization(env: Env, shareId: string, expiresAt: number): Promise<string> {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify({ v: 1, shareId, exp: expiresAt })));
  return `${encoded}.${bytesToBase64Url(await signature(env, encoded))}`;
}

export async function hasShareAuthorization(
  env: Env,
  request: Request,
  shareId: string,
  token: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const value = cookieValue(request, await cookieName(token));
  if (!value) return false;
  try {
    const [encoded, encodedSignature, extra] = value.split('.');
    if (!encoded || !encodedSignature || extra !== undefined) return false;
    if (!timingSafeEqual(await signature(env, encoded), base64UrlToBytes(encodedSignature))) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as AuthorizationPayload;
    return payload.v === 1
      && payload.shareId === shareId
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
