import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;
const masterKey = 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=';

async function createTestMount(): Promise<string> {
  const mount = await createMount(workerEnv().DB, {
    name: 'Credentials test',
    mountPath: '/credentials-test',
    driverType: 's3',
    provider: 'custom',
  });
  return mount.id;
}

describe('standard worker setup', () => {
  it('applies the storage credentials migration', async () => {
    const result = await workerEnv().DB.prepare('PRAGMA table_info(storage_credentials)').all<{ name: string }>();

    expect(result.results.map((column) => column.name)).toEqual([
      'mount_id',
      'ciphertext',
      'key_version',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('storage credentials', () => {
  beforeEach(async () => {
    await workerEnv().DB.prepare('DELETE FROM storage_credentials').run();
    await workerEnv().DB.prepare('DELETE FROM mounts').run();
  });

  it('round trips credentials without storing plaintext', async () => {
    const { getCredentials, putCredentials } = await import('../../src/worker/credentials');
    const mountId = await createTestMount();

    await putCredentials(workerEnv(), mountId, { accessKeyId: 'key', secretAccessKey: 'secret' });

    const row = await workerEnv()
      .DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?')
      .bind(mountId)
      .first<{ ciphertext: string }>();

    expect(row?.ciphertext).not.toContain('secret');
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({ accessKeyId: 'key', secretAccessKey: 'secret' });
  });

  it('deletes stored credentials', async () => {
    const { deleteCredentials, getCredentials, putCredentials } = await import('../../src/worker/credentials');
    const mountId = await createTestMount();

    await putCredentials(workerEnv(), mountId, { accessKeyId: 'key', secretAccessKey: 'secret' });
    await deleteCredentials(workerEnv(), mountId);

    await expect(getCredentials(workerEnv(), mountId)).resolves.toBeNull();
  });

  it('rejects a credential envelope decrypted with another key', async () => {
    const { decryptCredential, encryptCredential } = await import('../../src/worker/crypto');
    const envelope = await encryptCredential({ secretAccessKey: 'secret' }, masterKey, 'mount-a');

    await expect(decryptCredential(envelope, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=', 'mount-a')).rejects.toThrow();
  });

  it('rejects a credential envelope for a different mount', async () => {
    const { decryptCredential, encryptCredential } = await import('../../src/worker/crypto');
    const envelope = await encryptCredential({ secretAccessKey: 'secret' }, masterKey, 'mount-a');

    await expect(decryptCredential(envelope, masterKey, 'mount-b')).rejects.toThrow();
  });

  it('fails closed for malformed stored ciphertext', async () => {
    const { getCredentials } = await import('../../src/worker/credentials');
    const mountId = await createTestMount();
    const now = new Date().toISOString();
    await workerEnv()
      .DB.prepare(
        `INSERT INTO storage_credentials (mount_id, ciphertext, key_version, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .bind(mountId, '{not-json', now, now)
      .run();

    await expect(getCredentials(workerEnv(), mountId)).rejects.toThrow();
  });
});
