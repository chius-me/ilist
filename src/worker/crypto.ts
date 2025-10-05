const AES_GCM_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export const CREDENTIAL_ENVELOPE_VERSION = 1;

export interface CredentialEnvelope {
  version: typeof CREDENTIAL_ENVELOPE_VERSION;
  iv: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64 data');
  }

  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertMountId(mountId: string): void {
  if (!mountId) throw new Error('Mount ID is required');
}

async function importMasterKey(masterKey: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(masterKey);
  if (keyBytes.byteLength !== AES_GCM_KEY_BYTES) throw new Error('Credential master key must be 32 bytes');
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function parseEnvelope(envelope: string): CredentialEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw new Error('Invalid credential envelope');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<CredentialEnvelope>).version !== CREDENTIAL_ENVELOPE_VERSION ||
    typeof (parsed as Partial<CredentialEnvelope>).iv !== 'string' ||
    typeof (parsed as Partial<CredentialEnvelope>).ciphertext !== 'string'
  ) {
    throw new Error('Invalid credential envelope');
  }

  return parsed as CredentialEnvelope;
}

export async function encryptCredential(value: unknown, masterKey: string, mountId: string): Promise<string> {
  assertMountId(mountId);

  let plaintext: string;
  try {
    plaintext = JSON.stringify(value);
  } catch {
    throw new Error('Credential value must be JSON serializable');
  }
  if (plaintext === undefined) throw new Error('Credential value must be JSON serializable');

  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(mountId),
    },
    await importMasterKey(masterKey),
    new TextEncoder().encode(plaintext),
  );

  return JSON.stringify({
    version: CREDENTIAL_ENVELOPE_VERSION,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies CredentialEnvelope);
}

export async function decryptCredential(envelope: string, masterKey: string, mountId: string): Promise<unknown> {
  assertMountId(mountId);

  try {
    const parsed = parseEnvelope(envelope);
    const iv = base64ToBytes(parsed.iv);
    const ciphertext = base64ToBytes(parsed.ciphertext);
    if (iv.byteLength !== AES_GCM_IV_BYTES || ciphertext.byteLength < AES_GCM_TAG_BYTES) {
      throw new Error('Invalid credential envelope');
    }

    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(mountId),
      },
      await importMasterKey(masterKey),
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Credential decryption failed');
  }
}
