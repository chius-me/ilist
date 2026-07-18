import { sha256Hex } from './auth';
import { HttpError } from './http';
import type { Env } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidHandle();
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function invalidHandle(): HttpError {
  return new HttpError(400, 'SHARE_ITEM_INVALID', 'Shared item is invalid');
}

async function itemKey(env: Env): Promise<CryptoKey> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`ilist:share-item:v1:${env.SESSION_SECRET}`),
  );
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function createShareToken(): { token: string; tokenHash: Promise<string> } {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, tokenHash: sha256Hex(token) };
}

export async function sealShareItem(env: Env, shareId: string, itemId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(shareId) },
    await itemKey(env),
    encoder.encode(JSON.stringify({ v: 1, itemId })),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openShareItem(env: Env, shareId: string, handle: string): Promise<string> {
  try {
    const [version, ivValue, ciphertextValue, extra] = handle.split('.');
    if (version !== 'v1' || !ivValue || !ciphertextValue || extra !== undefined) throw invalidHandle();
    const iv = base64UrlToBytes(ivValue);
    if (iv.byteLength !== 12) throw invalidHandle();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(shareId) },
      await itemKey(env),
      base64UrlToBytes(ciphertextValue),
    );
    const payload = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
    if (payload.v !== 1 || typeof payload.itemId !== 'string' || !payload.itemId) throw invalidHandle();
    return payload.itemId;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'SHARE_ITEM_INVALID') throw error;
    throw invalidHandle();
  }
}
