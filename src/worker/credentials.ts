import { CREDENTIAL_ENVELOPE_VERSION, decryptCredential, encryptCredential } from './crypto';
import type { Env } from './types';

export type StorageCredentials = Record<string, unknown>;

export interface OAuthApplicationCredentials extends StorageCredentials {
  clientId: string;
  clientSecret: string;
}

export interface MountSecrets extends StorageCredentials {
  app?: StorageCredentials;
  auth?: StorageCredentials;
  provider?: StorageCredentials;
}

interface StorageCredentialRow {
  ciphertext: string;
}

function isStorageCredentials(value: unknown): value is StorageCredentials {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function preparePutCredentials(
  env: Env,
  mountId: string,
  credentials: StorageCredentials,
): Promise<D1PreparedStatement> {
  const ciphertext = await encryptCredential(credentials, env.CREDENTIAL_MASTER_KEY, mountId);
  const now = new Date().toISOString();

  return env.DB.prepare(
    `INSERT INTO storage_credentials (mount_id, ciphertext, key_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(mount_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       key_version = excluded.key_version,
       updated_at = excluded.updated_at`,
  )
    .bind(mountId, ciphertext, CREDENTIAL_ENVELOPE_VERSION, now, now);
}

export function prepareDeleteCredentials(db: D1Database, mountId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM storage_credentials WHERE mount_id = ?').bind(mountId);
}

export async function putCredentials(env: Env, mountId: string, credentials: StorageCredentials): Promise<void> {
  await (await preparePutCredentials(env, mountId, credentials)).run();
}

function mergeSecretRecord(
  current: StorageCredentials,
  patch: StorageCredentials,
): StorageCredentials {
  const merged: StorageCredentials = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    const prior = merged[key];
    if (isStorageCredentials(prior) && isStorageCredentials(value)) {
      const nested = mergeSecretRecord(prior, value);
      if (Object.keys(nested).length) merged[key] = nested;
      else delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Applies explicit patch semantics to an encrypted mount credential document.
 * Omitted/undefined fields are retained and null removes a field.
 */
export async function patchCredentials(
  env: Env,
  mountId: string,
  patch: StorageCredentials,
): Promise<StorageCredentials> {
  const next = mergeSecretRecord(await getCredentials(env, mountId) ?? {}, patch);
  if (Object.keys(next).length === 0) await deleteCredentials(env, mountId);
  else await putCredentials(env, mountId, next);
  return next;
}

export function nestedSecrets(
  credentials: StorageCredentials | null,
  section: 'app' | 'auth' | 'provider',
): StorageCredentials {
  const value = credentials?.[section];
  return isStorageCredentials(value) ? value : {};
}

export function oauthApplicationCredentials(
  credentials: StorageCredentials | null,
): OAuthApplicationCredentials | null {
  const app = nestedSecrets(credentials, 'app');
  if (typeof app.clientId !== 'string' || !app.clientId || typeof app.clientSecret !== 'string' || !app.clientSecret) {
    return null;
  }
  return { clientId: app.clientId, clientSecret: app.clientSecret };
}

/** Reads the nested auth document, with a flat-document fallback for pre-v0.3 credentials. */
export function authorizationSecrets(credentials: StorageCredentials | null): StorageCredentials {
  const nested = nestedSecrets(credentials, 'auth');
  if (Object.keys(nested).length) return nested;
  if (!credentials) return {};
  const result: StorageCredentials = {};
  for (const key of ['accessToken', 'refreshToken', 'tokenType', 'expiresAt', 'scope']) {
    if (credentials[key] !== undefined) result[key] = credentials[key];
  }
  return result;
}

/** Reads provider secrets, with a flat-document fallback for existing S3 credentials. */
export function providerSecrets(credentials: StorageCredentials | null): StorageCredentials {
  const nested = nestedSecrets(credentials, 'provider');
  return Object.keys(nested).length ? nested : credentials ?? {};
}

export async function getCredentials<T extends StorageCredentials = StorageCredentials>(env: Env, mountId: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?').bind(mountId).first<StorageCredentialRow>();
  if (!row) return null;

  const credentials = await decryptCredential(row.ciphertext, env.CREDENTIAL_MASTER_KEY, mountId);
  if (!isStorageCredentials(credentials)) throw new Error('Stored credentials are invalid');
  return credentials as T;
}

export async function deleteCredentials(env: Env, mountId: string): Promise<void> {
  await prepareDeleteCredentials(env.DB, mountId).run();
}
