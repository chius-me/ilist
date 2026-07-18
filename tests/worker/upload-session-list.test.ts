import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSession, sha256Hex } from '../../src/worker/auth';
import { encodeExternalId } from '../../src/worker/external-identity';
import { createUploadSessionRecord, listOwnedActiveUploadSessions } from '../../src/worker/upload-session-store';
import { listResumableUploads } from '../../src/worker/upload-service';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('upload session listing for resume', () => {
  it('lists unfinished owned sessions with progress fields', async () => {
    const created = await createSession(workerEnv());
    const ownerSessionId = await sha256Hex(`${workerEnv().SESSION_SECRET}:${created.token}`);
    const now = Date.now();
    await createUploadSessionRecord(workerEnv(), ownerSessionId, {
      mountId: 'native-r2',
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
      parentItemId: encodeExternalId('native-r2', 'parent'),
      mountId: 'native-r2',
      uploadedBytes: 0,
      kind: 'multipart',
    });
    expect(views[0].id).toBe(listed[0].id);
  });
});
