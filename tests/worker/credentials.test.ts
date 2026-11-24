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

  it('patches one secret section without erasing unrelated application or account state', async () => {
    const { getCredentials, patchCredentials, putCredentials } = await import('../../src/worker/credentials');
    const mountId = await createTestMount();
    await putCredentials(workerEnv(), mountId, {
      app: { clientId: 'client', clientSecret: 'secret' },
      auth: { accessToken: 'access', refreshToken: 'refresh' },
    });

    await patchCredentials(workerEnv(), mountId, { app: { clientSecret: 'replacement' } });

    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({
      app: { clientId: 'client', clientSecret: 'replacement' },
      auth: { accessToken: 'access', refreshToken: 'refresh' },
    });
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

  it('retries CAS conflicts in patchCredentials and fails with 409 on persistent contention', async () => {
    const { getCredentials, patchCredentials, putCredentials } = await import('../../src/worker/credentials');
    const mountId = await createTestMount();
    await putCredentials(workerEnv(), mountId, {
      app: { clientId: 'cid', clientSecret: 'csec' },
      auth: { accessToken: 'v0', refreshToken: 'r0' },
    });

    let racedOnce = false;
    const oneRaceDb = new Proxy(workerEnv().DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes('AND ciphertext = ?')) return stmt;
            return new Proxy(stmt, {
              get(stTarget, stProp) {
                if (stProp === 'bind') {
                  return (...vals: unknown[]) => {
                    const bound = stTarget.bind(...vals);
                    return new Proxy(bound, {
                      get(bTarget, bProp) {
                        if (bProp === 'run') {
                          return async () => {
                            if (!racedOnce) {
                              racedOnce = true;
                              await putCredentials(workerEnv(), mountId, {
                                app: { clientId: 'cid', clientSecret: 'csec' },
                                auth: { accessToken: 'concurrent', refreshToken: 'r1' },
                              });
                            }
                            return bTarget.run();
                          };
                        }
                        const v = Reflect.get(bTarget, bProp, bTarget);
                        return typeof v === 'function' ? v.bind(bTarget) : v;
                      },
                    });
                  };
                }
                const v = Reflect.get(stTarget, stProp, stTarget);
                return typeof v === 'function' ? v.bind(stTarget) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as D1Database;

    await patchCredentials({ ...workerEnv(), DB: oneRaceDb }, mountId, { app: { clientSecret: 'updated' } });
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({
      app: { clientId: 'cid', clientSecret: 'updated' },
      auth: { accessToken: 'concurrent', refreshToken: 'r1' },
    });

    const alwaysRaceDb = new Proxy(workerEnv().DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes('AND ciphertext = ?')) return stmt;
            return new Proxy(stmt, {
              get(stTarget, stProp) {
                if (stProp === 'bind') {
                  return (...vals: unknown[]) => {
                    const bound = stTarget.bind(...vals);
                    return new Proxy(bound, {
                      get(bTarget, bProp) {
                        if (bProp === 'run') {
                          return async () => ({ success: true, results: [], meta: { changes: 0 } });
                        }
                        const v = Reflect.get(bTarget, bProp, bTarget);
                        return typeof v === 'function' ? v.bind(bTarget) : v;
                      },
                    });
                  };
                }
                const v = Reflect.get(stTarget, stProp, stTarget);
                return typeof v === 'function' ? v.bind(stTarget) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as D1Database;

    await expect(patchCredentials({ ...workerEnv(), DB: alwaysRaceDb }, mountId, { app: { clientSecret: 'fail' } }))
      .rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_UPDATE_CONFLICT' });
  });
});
