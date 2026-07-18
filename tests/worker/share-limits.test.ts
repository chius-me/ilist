import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/worker/auth';
import { routeRequest } from '../../src/worker/router';
import {
  createShareRecord,
  getShareById,
  getShareByTokenHash,
  tryConsumeShareDownload,
  updateShareRecord,
} from '../../src/worker/share-store';
import { createShareToken } from '../../src/worker/share-crypto';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('share download limits and token rotation', () => {
  it('atomically consumes downloads until the max is reached', async () => {
    const token = createShareToken();
    const share = await createShareRecord(workerEnv().DB, {
      tokenHash: await token.tokenHash,
      mountId: 'native-r2',
      providerItemId: 'root',
      targetKind: 'file',
      name: 'limited.txt',
      passwordHash: null,
      expiresAt: null,
      allowDownload: true,
      enabled: true,
      maxDownloads: 2,
    });

    await expect(tryConsumeShareDownload(workerEnv().DB, share.id)).resolves.toBe(true);
    await expect(tryConsumeShareDownload(workerEnv().DB, share.id)).resolves.toBe(true);
    await expect(tryConsumeShareDownload(workerEnv().DB, share.id)).resolves.toBe(false);

    const updated = await getShareById(workerEnv().DB, share.id);
    expect(updated?.downloadCount).toBe(2);
    expect(updated?.maxDownloads).toBe(2);
  });

  it('rejects public access after token rotation while keeping policy fields', async () => {
    const first = createShareToken();
    const share = await createShareRecord(workerEnv().DB, {
      tokenHash: await first.tokenHash,
      mountId: 'native-r2',
      providerItemId: 'root',
      targetKind: 'folder',
      name: 'rotate-me',
      passwordHash: null,
      expiresAt: null,
      allowDownload: true,
      enabled: true,
      maxDownloads: 5,
    });

    await updateShareRecord(workerEnv().DB, share.id, {
      tokenHash: await sha256Hex('replacement-token-value-with-enough-length'),
      maxDownloads: 5,
    });

    await expect(getShareByTokenHash(workerEnv().DB, await first.tokenHash)).resolves.toBeNull();
    const rotated = await getShareById(workerEnv().DB, share.id);
    expect(rotated?.maxDownloads).toBe(5);
    expect(rotated?.allowDownload).toBe(true);
    expect(rotated?.tokenHash).not.toBe(await first.tokenHash);

    const response = await routeRequest(new Request(`https://example.test/s/${first.token}/api`), workerEnv());
    expect(response.status).toBe(404);
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('SHARE_NOT_FOUND');
  });
});
