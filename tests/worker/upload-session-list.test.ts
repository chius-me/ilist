import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/worker/auth';
import { encodeExternalId } from '../../src/worker/external-identity';
import { createMount } from '../../src/worker/mounts';
import { createUploadSessionRecord, listOwnedActiveUploadSessions } from '../../src/worker/upload-session-store';
import { listResumableUploads } from '../../src/worker/upload-service';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('upload session listing for resume', () => {
  it('lists unfinished owned sessions with progress fields', async () => {
    await workerEnv().DB.prepare('DELETE FROM mounts').run();
    const mount = await createMount(workerEnv().DB, {
      name: 'Resume Mount',
      mountPath: '/resume-mount',
      driverType: 's3',
      provider: 'custom',
    });
    const created = await createSession(workerEnv());
    const ownerSessionId = created.id;
    const now = Date.now();
    await createUploadSessionRecord(workerEnv(), ownerSessionId, {
      mountId: mount.id,
      parentItemId: 'parent',
      name: 'large.bin',
      size: 20 * 1024 * 1024,
      contentType: 'application/octet-stream',
      partSize: 10 * 1024 * 1024,
      providerState: { uploadId: 'u1', key: 'large.bin' },
      expiresAt: now + 60_000,
    });

    const listed = await listOwnedActiveUploadSessions(workerEnv(), ownerSessionId, now);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: 'large.bin',
      size: 20 * 1024 * 1024,
      status: 'active',
    });

    const views = await listResumableUploads(workerEnv(), ownerSessionId);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      name: 'large.bin',
      parentItemId: encodeExternalId(mount.id, 'parent'),
      mountId: mount.id,
      uploadedBytes: 0,
      kind: 'multipart',
    });
    expect(views[0].id).toBe(listed[0].id);
  });
});
