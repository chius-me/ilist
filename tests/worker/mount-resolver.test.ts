import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/worker/http';
import { resolveVirtualPath } from '../../src/worker/mount-resolver';
import { createDriver } from '../../src/worker/drivers/registry';
import type { DriverRegistry, StorageDriver } from '../../src/worker/drivers/types';
import type { Env, Mount } from '../../src/worker/types';

const mounts: Mount[] = [
  {
    id: 'personal-drive',
    name: 'Personal Drive',
    mountPath: '/Personal Drive',
    driverType: 's3',
    provider: 'custom',
    enabled: true,
    isPublic: true,
    sortOrder: 0,
    rootItemId: null,
    config: { bucket: 'personal' },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  },
];

function expectHttpError(run: () => unknown, code: string, status: number): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ code, status });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('resolveVirtualPath', () => {
  it('resolves a named mount and preserves the provider-relative path', () => {
    expect(resolveVirtualPath('/Personal Drive/Documents', mounts)).toEqual({
      mount: mounts[0],
      relativePath: '/Documents',
    });
  });

  it('matches decoded top-level segments exactly', () => {
    expect(resolveVirtualPath('/Personal%20Drive/Tax%20Documents', mounts)).toEqual({
      mount: mounts[0],
      relativePath: '/Tax Documents',
    });
    expectHttpError(() => resolveVirtualPath('/Personal Drive Archive', mounts), 'MOUNT_NOT_FOUND', 404);
  });

  it('rejects missing and disabled mounts with stable errors', () => {
    expectHttpError(() => resolveVirtualPath('/Unknown', mounts), 'MOUNT_NOT_FOUND', 404);
    expectHttpError(() => resolveVirtualPath('/Personal Drive', [{ ...mounts[0], enabled: false }]), 'MOUNT_DISABLED', 403);
  });
});

describe('createDriver', () => {
  it('rejects a mount whose driver has not been registered', async () => {
    await expect(createDriver({} as Env, { ...mounts[0], driverType: 'onedrive' }, {})).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      status: 503,
    });
  });

  it('passes only environment, mount metadata, and decrypted credentials to the registered factory', async () => {
    const driver: StorageDriver = {
      rootId: 'root',
      capabilities: new Set(),
      list: async () => ({ items: [], nextCursor: null }),
      stat: async () => {
        throw new Error('not used');
      },
      getDownload: async () => {
        throw new Error('not used');
      },
      createFolder: async () => {
        throw new Error('not used');
      },
      upload: async () => {
        throw new Error('not used');
      },
      rename: async () => {
        throw new Error('not used');
      },
      move: async () => {
        throw new Error('not used');
      },
      remove: async () => {
        throw new Error('not used');
      },
    };
    const factory = vi.fn().mockResolvedValue(driver);
    const registry: DriverRegistry = { s3: factory };
    const env = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
          }),
        }),
      },
    } as unknown as Env;

    await expect(createDriver(env, mounts[0], registry)).resolves.toBe(driver);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(env, mounts[0], null);
  });
});
