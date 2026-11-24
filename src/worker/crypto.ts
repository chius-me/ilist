import { base64ToBytes, bytesToBase64 } from './shared/encoding';
import { deriveCredentialAesKey, inferCredentialDomain, type CredentialDomain } from './shared/keys';

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export const CREDENTIAL_ENVELOPE_VERSION = 2;

export interface CredentialEnvelope {
  version: 1 | 2;
  iv: string;
  ciphertext: string;
}

export interface CredentialCryptoOptions {
  domain?: CredentialDomain;
  expectedKeyVersion?: number;
}

function assertMountId(mountId: string): void {
  if (!mountId) throw new Error('Mount ID is required');
}

function parseEnvelope(envelope: string): CredentialEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw new Error('Invalid credential envelope');
  }

  const version = (parsed as Partial<CredentialEnvelope> | null)?.version;
  if (
    !parsed
    || typeof parsed !== 'object'
    || (version !== 1 && version !== 2)
    || typeof (parsed as Partial<CredentialEnvelope>).iv !== 'string'
    || typeof (parsed as Partial<CredentialEnvelope>).ciphertext !== 'string'
  ) {
    throw new Error('Invalid credential envelope');
  }

  return parsed as CredentialEnvelope;
}

export async function encryptCredential(
  value: unknown,
  masterKey: string,
  mountId: string,
  options: CredentialCryptoOptions = {},
): Promise<string> {
  assertMountId(mountId);

  let plaintext: string;
  try {
    plaintext = JSON.stringify(value);
  } catch {
    throw new Error('Credential value must be JSON serializable');
  }
  if (plaintext === undefined) throw new Error('Credential value must be JSON serializable');

  const domain = options.domain ?? inferCredentialDomain(mountId);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(mountId),
    },
    await deriveCredentialAesKey(masterKey, domain, CREDENTIAL_ENVELOPE_VERSION),
    new TextEncoder().encode(plaintext),
  );

  return JSON.stringify({
    version: CREDENTIAL_ENVELOPE_VERSION,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies CredentialEnvelope);
}

export async function decryptCredential(
  envelope: string,
  masterKey: string,
  mountId: string,
  options: CredentialCryptoOptions = {},
): Promise<unknown> {
  assertMountId(mountId);

  try {
    const parsed = parseEnvelope(envelope);
    if (
      options.expectedKeyVersion !== undefined
      && options.expectedKeyVersion !== 1
      && options.expectedKeyVersion !== 2
    ) {
      throw new Error('Unsupported key version');
    }
    if (options.expectedKeyVersion !== undefined && parsed.version !== options.expectedKeyVersion) {
      throw new Error('Credential key version mismatch');
    }

    const iv = base64ToBytes(parsed.iv);
    const ciphertext = base64ToBytes(parsed.ciphertext);
    if (iv.byteLength !== AES_GCM_IV_BYTES || ciphertext.byteLength < AES_GCM_TAG_BYTES) {
      throw new Error('Invalid credential envelope');
    }

    const domain = options.domain ?? inferCredentialDomain(mountId);
    const key = await deriveCredentialAesKey(masterKey, domain, parsed.version);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(mountId),
      },
      key,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Credential decryption failed');
  }
}
