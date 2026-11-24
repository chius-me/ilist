import { base64ToBytes } from './encoding';

export type CredentialDomain = 'storage-credentials' | 'oauth-states' | 'upload-sessions';
export type SessionSecretDomain = 'admin-session' | 'rate-limit' | 'share-auth' | 'share-item' | 'onedrive-upload';

const encoder = new TextEncoder();
const HKDF_SALT = encoder.encode('ilist-hkdf-v2');
const MAX_CACHED_KEYS = 64;

const keyCache = new Map<string, CryptoKey>();

function cacheSet(cacheKey: string, cryptoKey: CryptoKey): CryptoKey {
  if (keyCache.size >= MAX_CACHED_KEYS) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(cacheKey, cryptoKey);
  return cryptoKey;
}

export function inferCredentialDomain(aad: string): CredentialDomain {
  if (aad.startsWith('oauth-state:')) return 'oauth-states';
  if (aad.startsWith('upload-session:')) return 'upload-sessions';
  return 'storage-credentials';
}

export async function deriveCredentialAesKey(
  masterKey: string,
  domain: CredentialDomain,
  version: 1 | 2,
): Promise<CryptoKey> {
  const cacheKey = `cred:${version}:${domain}:${masterKey}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const rawKeyBytes = base64ToBytes(masterKey);
  if (rawKeyBytes.byteLength !== 32) {
    throw new Error('Credential master key must be 32 bytes');
  }

  let derived: CryptoKey;
  if (version === 1) {
    derived = await crypto.subtle.importKey('raw', rawKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } else {
    const baseKey = await crypto.subtle.importKey('raw', rawKeyBytes, 'HKDF', false, ['deriveKey']);
    derived = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(`ilist:credential:${domain}:v2`) },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }
  return cacheSet(cacheKey, derived);
}

export async function deriveSessionHmacKey(
  sessionSecret: string,
  domain: SessionSecretDomain,
): Promise<CryptoKey> {
  const cacheKey = `hmac:v2:${domain}:${sessionSecret}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(sessionSecret), 'HKDF', false, ['deriveKey']);
  const derived = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(`ilist:session:${domain}:v2`) },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return cacheSet(cacheKey, derived);
}

export async function deriveSessionAesKey(
  sessionSecret: string,
  domain: SessionSecretDomain,
): Promise<CryptoKey> {
  const cacheKey = `aes:v2:${domain}:${sessionSecret}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(sessionSecret), 'HKDF', false, ['deriveKey']);
  const derived = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(`ilist:session:${domain}:v2`) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return cacheSet(cacheKey, derived);
}

export async function legacyRawHmacKey(secret: string): Promise<CryptoKey> {
  const cacheKey = `hmac:legacy-raw:${secret}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return cacheSet(cacheKey, key);
}

export async function legacyDigestHmacKey(material: string): Promise<CryptoKey> {
  const cacheKey = `hmac:legacy-digest:${material}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return cacheSet(cacheKey, key);
}

export async function legacyDigestAesKey(material: string): Promise<CryptoKey> {
  const cacheKey = `aes:legacy-digest:${material}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return cacheSet(cacheKey, key);
}
