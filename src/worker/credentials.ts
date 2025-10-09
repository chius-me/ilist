import { CREDENTIAL_ENVELOPE_VERSION, decryptCredential, encryptCredential } from './crypto';
import type { Env } from './types';

export type StorageCredentials = Record<string, unknown>;

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
