import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hashPassword, sha256Hex, verifyPassword } from '../../src/worker/auth';
import {
  createShareRecord,
  deleteShareRecord,
  getShareById,
  getShareByTokenHash,
  listShares,
  updateShareRecord,
} from '../../src/worker/share-store';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('share store', () => {
  it('creates and resolves a share without retaining the raw token', async () => {
    const tokenHash = await sha256Hex('raw-share-token');
    const share = await createShareRecord(workerEnv().DB, {
      tokenHash,
      mountId: 'native-r2',
      providerItemId: 'private-file',
      targetKind: 'file',
      name: 'private.txt',
      passwordHash: null,
      expiresAt: null,
      allowDownload: false,
      enabled: true,
    });

    expect(share).toMatchObject({
      mountId: 'native-r2',
      providerItemId: 'private-file',
      targetKind: 'file',
      name: 'private.txt',
      passwordHash: null,
      expiresAt: null,
      allowDownload: false,
      enabled: true,
    });
    expect(JSON.stringify(share)).not.toContain('raw-share-token');
    await expect(getShareByTokenHash(workerEnv().DB, tokenHash)).resolves.toEqual(share);
    await expect(getShareById(workerEnv().DB, share.id)).resolves.toEqual(share);
  });

  it('lists, updates, and deletes share policy without changing the token hash', async () => {
    const tokenHash = await sha256Hex('policy-token');
    const created = await createShareRecord(workerEnv().DB, {
      tokenHash,
      mountId: 'native-r2',
      providerItemId: 'folder-id',
      targetKind: 'folder',
      name: 'Folder',
      passwordHash: null,
      expiresAt: null,
      allowDownload: true,
      enabled: true,
    });

    const passwordHash = await hashPassword('share-password');
    const updated = await updateShareRecord(workerEnv().DB, created.id, {
      passwordHash,
      expiresAt: 2_000_000_000,
      allowDownload: false,
      enabled: false,
    });

    expect(updated).toMatchObject({
      id: created.id,
      tokenHash,
      passwordHash,
      expiresAt: 2_000_000_000,
      allowDownload: false,
      enabled: false,
    });
    expect(await listShares(workerEnv().DB)).toContainEqual(updated);
    await expect(deleteShareRecord(workerEnv().DB, created.id)).resolves.toBe(true);
    await expect(getShareById(workerEnv().DB, created.id)).resolves.toBeNull();
    await expect(deleteShareRecord(workerEnv().DB, created.id)).resolves.toBe(false);
  });

  it('cascades shares when their mount is deleted', async () => {
    const share = await createShareRecord(workerEnv().DB, {
      tokenHash: await sha256Hex('cascade-token'),
      mountId: 'native-r2',
      providerItemId: 'file-id',
      targetKind: 'file',
      name: 'file.txt',
      passwordHash: null,
      expiresAt: null,
      allowDownload: true,
      enabled: true,
    });

    await workerEnv().DB.prepare("DELETE FROM mounts WHERE id = 'native-r2'").run();
    await expect(getShareById(workerEnv().DB, share.id)).resolves.toBeNull();
  });

  it('hashes optional share passwords using the existing verification format', async () => {
    const stored = await hashPassword('share-password');
    expect(stored).toMatch(/^pbkdf2:100000:[0-9a-f]{32}:[0-9a-f]{64}$/);
    await expect(verifyPassword('share-password', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });
});
