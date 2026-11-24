import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { listVirtualDirectory } from '../../src/worker/file-system';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;
const workerEnv = () => env as unknown as Env;

function makeDriver(itemsByParent: Record<string, StorageItem[]>): StorageDriver {
  return {
    rootId: 'root',
    capabilities: new Set(['list', 'download']),
    list: vi.fn(async (parentId) => ({ items: itemsByParent[parentId] ?? [], nextCursor: null })),
    stat: vi.fn(async (id) => ({
      id,
      parentId: id === 'root' ? null : 'root',
      name: id === 'root' ? 'Root' : 'Public',
      kind: 'folder' as const,
      size: null,
      contentType: null,
      modifiedAt: null,
      etag: null,
    })),
    isWithin: vi.fn(async () => true),
    getDownload: vi.fn(),
    createFolder: vi.fn(),
    upload: vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    copy: vi.fn(),
    remove: vi.fn(),
  };
}

describe('virtual mount file system', () => {
  it('lists only visible enabled mounts without contacting their providers', async () => {
    await db().prepare('DELETE FROM mounts').run();
    await createMount(db(), {
      name: 'Private Archive',
      mountPath: '/private-archive',
      driverType: 's3',
      provider: 'custom',
      isPublic: false,
      sortOrder: 10,
    });
    await createMount(db(), {
      name: 'Unavailable Public',
      mountPath: '/unavailable-public',
      driverType: 's3',
      provider: 'custom',
      isPublic: true,
      sortOrder: 20,
    });
    await createMount(db(), {
      name: 'Disabled Public',
      mountPath: '/disabled-public',
      driverType: 's3',
      provider: 'custom',
      enabled: false,
      isPublic: true,
      sortOrder: 30,
    });
    const failingFactory = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    driverRegistry.s3 = failingFactory;

    try {
      const guest = await listVirtualDirectory(workerEnv(), '/', false);
      expect(guest.current).toMatchObject({ id: 'virtual-root', mountPath: null });
      expect(guest.items.map((item) => item.name)).toEqual(['Unavailable Public']);

      const admin = await listVirtualDirectory(workerEnv(), '/', true);
      expect(admin.items.map((item) => item.name)).toEqual(['Private Archive', 'Unavailable Public']);
      expect(admin.items[0]).toMatchObject({
        name: 'Private Archive',
        kind: 'folder',
        mountPath: '/private-archive',
        driverType: 's3',
        provider: 'custom',
        capabilities: { open: true, preview: false, download: false, rename: false, move: false, copy: false, delete: false },
      });
      expect(failingFactory).not.toHaveBeenCalled();
    } finally {
      delete driverRegistry.s3;
    }
  });

  it('normalizes trailing slashes when resolving mounted external directories', async () => {
    await db().prepare('DELETE FROM mounts').run();
    const mount = await createMount(db(), {
      name: 'Docs',
      mountPath: '/docs',
      driverType: 's3',
      provider: 'custom',
      isPublic: true,
    });
    driverRegistry.s3 = () => makeDriver({
      root: [{ id: 'sub', parentId: 'root', name: 'Public', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null }],
      sub: [{ id: 'note', parentId: 'sub', name: 'readme.txt', kind: 'file', size: 5, contentType: 'text/plain', modifiedAt: null, etag: 'e' }],
    });

    try {
      const listed = await listVirtualDirectory(workerEnv(), '/docs/Public/', false);
      expect(listed.current).toMatchObject({ name: 'Public', mountId: mount.id, mountPath: '/docs' });
      expect(listed.items.map((item) => item.name)).toEqual(['readme.txt']);
      expect(listed.breadcrumbs.map((crumb) => crumb.path)).toEqual(['/', '/docs', '/docs/Public']);
    } finally {
      delete driverRegistry.s3;
    }
  });

  it('does not reveal a private mount through a direct guest path and rejects retired native-r2 mounts', async () => {
    await db().prepare('DELETE FROM mounts').run();
    await createMount(db(), {
      name: 'Private Archive',
      mountPath: '/private-archive',
      driverType: 's3',
      provider: 'custom',
      isPublic: false,
    });
    await createMount(db(), {
      name: 'Legacy R2',
      mountPath: '/R2',
      driverType: 'native-r2',
      provider: 'cloudflare-r2',
      enabled: true,
      isPublic: true,
    });

    await expect(listVirtualDirectory(workerEnv(), '/private-archive', false)).rejects.toMatchObject({
      status: 404,
      code: 'MOUNT_NOT_FOUND',
    });
    await expect(listVirtualDirectory(workerEnv(), '/R2', false)).rejects.toMatchObject({
      status: 503,
      code: 'DRIVER_UNAVAILABLE',
    });
  });
});
