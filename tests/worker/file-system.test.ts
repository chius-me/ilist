import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import nativeR2CompatibilityMount from '../../migrations/0010_native_r2_compat_mount.sql?raw';
import { driverRegistry } from '../../src/worker/drivers/registry';
import {
  createFolder,
  listVirtualDirectory,
  moveEntries,
  patchEntry,
  setEntriesVisibility,
} from '../../src/worker/file-system';
import { getEntryById } from '../../src/worker/db';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

async function applyNativeR2CompatibilityMount(): Promise<void> {
  await db().prepare(nativeR2CompatibilityMount).run();
}

describe('virtual mount file system', () => {
  it('creates exactly one deterministic native R2 compatibility mount', async () => {
    await db().prepare('DELETE FROM mounts').run();

    await applyNativeR2CompatibilityMount();
    await applyNativeR2CompatibilityMount();

    const result = await db().prepare("SELECT * FROM mounts WHERE driver_type = 'native-r2'").all();
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      id: 'native-r2',
      name: 'R2',
      mount_path: '/R2',
      driver_type: 'native-r2',
      provider: 'cloudflare-r2',
      enabled: 1,
      is_public: 1,
      root_item_id: 'root',
    });
  });

  it('lists only visible enabled mounts without contacting their providers', async () => {
    await db().prepare('DELETE FROM mounts').run();
    await applyNativeR2CompatibilityMount();
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
      sortOrder: 20,
    });
    await createMount(db(), {
      name: 'Disabled Public',
      mountPath: '/disabled-public',
      driverType: 's3',
      provider: 'custom',
      enabled: false,
      sortOrder: 30,
    });
    const failingFactory = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    driverRegistry.s3 = failingFactory;

    try {
      const guest = await listVirtualDirectory(db(), '/', false);
      expect(guest.items.map((item) => item.name)).toEqual(['R2', 'Unavailable Public']);

      const admin = await listVirtualDirectory(db(), '/', true);
      expect(admin.items.map((item) => item.name)).toEqual(['R2', 'Private Archive', 'Unavailable Public']);
      expect(admin.items[0]).toMatchObject({
        id: 'native-r2',
        name: 'R2',
        kind: 'folder',
        mountId: 'native-r2',
        mountPath: '/R2',
        driverType: 'native-r2',
        provider: 'cloudflare-r2',
        capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false },
      });
      expect(failingFactory).not.toHaveBeenCalled();
    } finally {
      delete driverRegistry.s3;
    }
  });

  it('keeps the existing entry tree reachable beneath the native R2 mount', async () => {
    await db().prepare('DELETE FROM mounts').run();
    await applyNativeR2CompatibilityMount();
    const publicFolder = await createFolder(db(), { parentId: 'root', name: 'Public' });
    const privateFolder = await createFolder(db(), { parentId: 'root', name: 'Private' });
    await setEntriesVisibility(db(), [privateFolder.id], false);

    const guest = await listVirtualDirectory(db(), '/R2', false);
    expect(guest.items.map((item) => item.name)).toEqual(['Public']);
    expect(guest.breadcrumbs).toEqual([
      { id: 'virtual-root', name: 'ilist', path: '/' },
      { id: 'native-r2', name: 'R2', path: '/R2' },
    ]);

    const nested = await listVirtualDirectory(db(), '/R2/Public', false);
    expect(nested.current.id).toBe(publicFolder.id);
    expect(nested.breadcrumbs.map((item) => item.path)).toEqual(['/', '/R2', '/R2/Public']);
  });

  it('does not reveal a private mount through a direct guest path', async () => {
    await db().prepare('DELETE FROM mounts').run();
    await createMount(db(), {
      name: 'Private Archive',
      mountPath: '/private-archive',
      driverType: 's3',
      provider: 'custom',
      isPublic: false,
    });

    await expect(listVirtualDirectory(db(), '/private-archive', false)).rejects.toMatchObject({
      status: 404,
      code: 'MOUNT_NOT_FOUND',
    });
  });
});

describe('file system mutations', () => {
  it('creates a real empty folder that inherits visibility', async () => {
    const folder = await createFolder(db(), { parentId: 'root', name: '资料' });
    expect(folder).toMatchObject({ name: '资料', kind: 'folder', isPublic: true });
    expect(await getEntryById(db(), folder.id)).toMatchObject({ parent_id: 'root', storage_key: null });
  });

  it('renames metadata without changing a file storage key', async () => {
    const now = new Date().toISOString();
    await db().prepare(`INSERT INTO entries (
      id, parent_id, name, kind, storage_key, size, content_type, etag, status, is_public, sort_order, description, created_at, updated_at
    ) VALUES (?, 'root', ?, 'file', ?, 4, 'text/plain', 'e', 'ready', 1, 0, '', ?, ?)`).bind(
      'file-a', 'a.txt', 'blobs/file-a', now, now,
    ).run();
    await patchEntry(db(), 'file-a', { name: 'b.txt' });
    expect(await getEntryById(db(), 'file-a')).toMatchObject({ name: 'b.txt', storage_key: 'blobs/file-a' });
  });

  it('moves entries and rejects a folder cycle', async () => {
    const parent = await createFolder(db(), { parentId: 'root', name: 'Parent' });
    const child = await createFolder(db(), { parentId: parent.id, name: 'Child' });
    await expect(moveEntries(db(), [parent.id], child.id)).resolves.toMatchObject({ succeeded: [], failed: [{ id: parent.id }] });
    const destination = await createFolder(db(), { parentId: 'root', name: 'Destination' });
    await expect(moveEntries(db(), [child.id], destination.id)).resolves.toMatchObject({ succeeded: [child.id], failed: [] });
  });

  it('changes visibility for every valid selected entry', async () => {
    const one = await createFolder(db(), { parentId: 'root', name: 'One' });
    const two = await createFolder(db(), { parentId: 'root', name: 'Two' });
    const result = await setEntriesVisibility(db(), [one.id, two.id], false);
    expect(result.succeeded).toEqual([one.id, two.id]);
    expect((await getEntryById(db(), one.id))?.is_public).toBe(0);
  });

  it.each(['api', 'file', 'admin'])('rejects moving the reserved nested name %s to root', async (name) => {
    const parent = await createFolder(db(), { parentId: 'root', name: `Nested ${name}` });
    const entry = await createFolder(db(), { parentId: parent.id, name });

    await expect(moveEntries(db(), [entry.id], 'root')).resolves.toEqual({
      succeeded: [],
      failed: [{ id: entry.id, code: 'INVALID_ENTRY_NAME', message: 'Invalid entry name' }],
    });
    expect(await getEntryById(db(), entry.id)).toMatchObject({ parent_id: parent.id, name });
  });

  it('moves a legal nested entry to root', async () => {
    const parent = await createFolder(db(), { parentId: 'root', name: 'Nested' });
    const entry = await createFolder(db(), { parentId: parent.id, name: 'readme.txt' });

    await expect(moveEntries(db(), [entry.id], 'root')).resolves.toEqual({ succeeded: [entry.id], failed: [] });
    expect(await getEntryById(db(), entry.id)).toMatchObject({ parent_id: 'root', name: 'readme.txt' });
  });

  it('preserves concurrent changes to independent metadata fields', async () => {
    const entry = await createFolder(db(), { parentId: 'root', name: 'Concurrent' });

    await Promise.all([
      patchEntry(db(), entry.id, { description: 'Updated description' }),
      patchEntry(db(), entry.id, { sortOrder: 7 }),
      setEntriesVisibility(db(), [entry.id], false),
    ]);

    expect(await getEntryById(db(), entry.id)).toMatchObject({
      description: 'Updated description',
      sort_order: 7,
      is_public: 0,
    });
  });

  it('returns a structured name conflict when concurrent moves target the same sibling name', async () => {
    const left = await createFolder(db(), { parentId: 'root', name: 'Concurrent Left' });
    const right = await createFolder(db(), { parentId: 'root', name: 'Concurrent Right' });
    const destination = await createFolder(db(), { parentId: 'root', name: 'Concurrent Destination' });
    const first = await createFolder(db(), { parentId: left.id, name: 'Concurrent Duplicate' });
    const second = await createFolder(db(), { parentId: right.id, name: 'Concurrent Duplicate' });

    const results = await Promise.all([
      moveEntries(db(), [first.id], destination.id),
      moveEntries(db(), [second.id], destination.id),
    ]);
    const failed = results.flatMap((result) => result.failed);

    expect(results.flatMap((result) => result.succeeded)).toHaveLength(1);
    expect(failed).toEqual([{ id: expect.any(String), code: 'ENTRY_NAME_CONFLICT', message: 'Current folder already contains that name' }]);
  });

  it('returns a structured name conflict when concurrent renames use the same sibling name', async () => {
    const first = await createFolder(db(), { parentId: 'root', name: 'Rename First' });
    const second = await createFolder(db(), { parentId: 'root', name: 'Rename Second' });

    const results = await Promise.allSettled([
      patchEntry(db(), first.id, { name: 'Concurrent Rename' }),
      patchEntry(db(), second.id, { name: 'Concurrent Rename' }),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({
      status: 409,
      code: 'ENTRY_NAME_CONFLICT',
      message: 'Current folder already contains that name',
    });
  });

  it('returns a structured name conflict when concurrent folder creation uses the same sibling name', async () => {
    const results = await Promise.allSettled([
      createFolder(db(), { parentId: 'root', name: 'Concurrent Create' }),
      createFolder(db(), { parentId: 'root', name: 'Concurrent Create' }),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({
      status: 409,
      code: 'ENTRY_NAME_CONFLICT',
      message: 'Current folder already contains that name',
    });
  });
});
