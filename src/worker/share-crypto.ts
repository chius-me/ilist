import { sha256Hex } from './auth';
import { HttpError } from './http';
import { base64UrlToBytes, bytesToBase64Url } from './shared/encoding';
import { deriveSessionAesKey, legacyDigestAesKey } from './shared/keys';
import type { Env } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function invalidHandle(): HttpError {
  return new HttpError(400, 'SHARE_ITEM_INVALID', 'Shared item is invalid');
}

function decodeHandlePart(value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(value);
  } catch {
    throw invalidHandle();
  }
  if (bytesToBase64Url(bytes) !== value) throw invalidHandle();
  return bytes;
}

export function createShareToken(): { token: string; tokenHash: Promise<string> } {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, tokenHash: sha256Hex(token) };
}

export interface OpenedShareItem {
  rootItemId: string | null;
  itemId: string;
}

export async function sealShareItem(env: Env, shareId: string, rootItemId: string, itemId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSessionAesKey(env.SESSION_SECRET, 'share-item');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(shareId) },
    key,
    encoder.encode(JSON.stringify({ v: 2, rootItemId, itemId })),
  );
  return `v2.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptShareHandle(
  key: CryptoKey,
  shareId: string,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Record<string, unknown>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(shareId) },
    key,
    ciphertext,
  );
  return JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
}

export async function openShareItem(env: Env, shareId: string, handle: string): Promise<OpenedShareItem> {
  try {
    const [version, ivValue, ciphertextValue, extra] = handle.split('.');
    if ((version !== 'v1' && version !== 'v2') || !ivValue || !ciphertextValue || extra !== undefined) throw invalidHandle();
    const iv = decodeHandlePart(ivValue);
    if (iv.byteLength !== 12) throw invalidHandle();
    const ciphertext = decodeHandlePart(ciphertextValue);

    let payload: Record<string, unknown>;
    if (version === 'v2') {
      try {
        payload = await decryptShareHandle(await deriveSessionAesKey(env.SESSION_SECRET, 'share-item'), shareId, iv, ciphertext);
      } catch {
        payload = await decryptShareHandle(await legacyDigestAesKey(`ilist:share-item:v1:${env.SESSION_SECRET}`), shareId, iv, ciphertext);
      }
    } else {
      payload = await decryptShareHandle(await legacyDigestAesKey(`ilist:share-item:v1:${env.SESSION_SECRET}`), shareId, iv, ciphertext);
    }

    if (typeof payload.itemId !== 'string' || !payload.itemId) throw invalidHandle();
    if (version === 'v1' && payload.v === 1) return { rootItemId: null, itemId: payload.itemId };
    if (version === 'v2' && payload.v === 2 && typeof payload.rootItemId === 'string' && payload.rootItemId) {
      return { rootItemId: payload.rootItemId, itemId: payload.itemId };
    }
    throw invalidHandle();
  } catch (error) {
    if (error instanceof HttpError && error.code === 'SHARE_ITEM_INVALID') throw error;
    throw invalidHandle();
  }
}
