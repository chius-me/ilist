import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { matchesNameFilter } from '../../src/worker/entry-domain';
import { listVirtualDirectory } from '../../src/worker/file-system';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

const originalS3Factory = driverRegistry.s3;

describe('directory name filter on mounted storage', () => {
  afterEach(() => {
    driverRegistry.s3 = originalS3Factory;
  });

  it('matches names case-insensitively and ignores empty queries', () => {
    expect(matchesNameFilter('Reports', null)).toBe(true);
    expect(matchesNameFilter('Reports', '  ')).toBe(true);
    expect(matchesNameFilter('Reports', 'port')).toBe(true);
    expect(matchesNameFilter('Reports', 'PORT')).toBe(true);
    expect(matchesNameFilter('Reports', 'xyz')).toBe(false);
  });

  it('filters mounted external listings server-side', async () => {
    const db = workerEnv().DB;
    await db.prepare('DELETE FROM mounts').run();
    await createMount(db, {
      name: 'Docs S3',
      mountPath: '/docs-s3',
      driverType: 's3',
      provider: 'custom',
      isPublic: true,
    });

    const items: StorageItem[] = [
      { id: 'a', parentId: 'root', name: 'alpha-docs', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null },
      { id: 'b', parentId: 'root', name: 'beta-docs', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null },
      { id: 'c', parentId: 'root', name: 'notes', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null },
    ];
    driverRegistry.s3 = () => ({
      rootId: 'root',
      capabilities: new Set(['list']),
      list: vi.fn(async () => ({ items, nextCursor: null })),
      stat: vi.fn(async () => ({ id: 'root', parentId: null, name: 'Docs S3', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null })),
      isWithin: vi.fn(async () => true),
      getDownload: vi.fn(),
      createFolder: vi.fn(),
      upload: vi.fn(),
      rename: vi.fn(),
      move: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
    } as unknown as StorageDriver);

    const filtered = await listVirtualDirectory(workerEnv(), '/docs-s3', true, 'docs');
    expect(filtered.items.map((item) => item.name).sort()).toEqual(['alpha-docs', 'beta-docs']);
  });
});
