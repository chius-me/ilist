import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DriverRegistry, StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { createMount } from '../../src/worker/mounts';
import { openShareItem } from '../../src/worker/share-crypto';
import {
  downloadSharedFile,
  listSharedFolder,
  resolveShareCreationTarget,
  resolveSharedItem,
} from '../../src/worker/share-targets';
import type { Env, Share } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

function shareFor(mountId: string, providerItemId: string, targetKind: 'file' | 'folder', name: string): Share {
  return {
    id: `share-${providerItemId}`,
    tokenHash: 'a'.repeat(64),
    mountId,
    providerItemId,
    targetKind,
    name,
    passwordHash: null,
    expiresAt: null,
    allowDownload: false,
    enabled: true,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

async function insertNativeTree(): Promise<void> {
  const db = workerEnv().DB;
  const now = '2026-07-18T00:00:00.000Z';
  await db.prepare("DELETE FROM entries WHERE id = 'private-child'").run();
  await db.prepare("DELETE FROM entries WHERE id = 'private-folder'").run();
  await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag, status,
    lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) VALUES (?, 'root', ?, 'folder', NULL, 0, NULL, NULL, 'ready', NULL, 0, 0, '', ?, ?)`)
    .bind('private-folder', 'Private folder', now, now).run();
  await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag, status,
    lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) VALUES (?, 'private-folder', ?, 'file', ?, 12, 'text/plain', 'etag', 'ready', NULL, 0, 0, '', ?, ?)`)
    .bind('private-child', 'private.txt', 'share/private.txt', now, now).run();
  await workerEnv().R2_BUCKET.put('share/private.txt', 'private-data', { httpMetadata: { contentType: 'text/plain' } });
}

function fakeDriver(): StorageDriver {
  const root: StorageItem = { id: 'root-id', parentId: null, name: 'Root', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null };
  const folder: StorageItem = { id: 'provider-folder', parentId: root.id, name: 'External folder', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null };
  const file: StorageItem = {
    id: 'provider-file-secret',
    parentId: folder.id,
    name: 'external.txt',
    kind: 'file',
    size: 8,
    contentType: 'text/plain',
    modifiedAt: null,
    etag: 'etag',
    exportOptions: [
      { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' },
    ],
  };
  return {
    rootId: root.id,
    capabilities: new Set(['list', 'download']),
    list: vi.fn(async (parentId: string) => ({ items: parentId === folder.id ? [file] : [folder], nextCursor: null })),
    stat: vi.fn(async (itemId: string) => {
      const item = [root, folder, file].find((candidate) => candidate.id === itemId);
      if (!item) throw new Error('missing');
      return item;
    }),
    getDownload: vi.fn(async () => ({
      kind: 'stream' as const,
      response: new Response('external', {
        headers: {
          'content-type': 'text/html',
          'content-disposition': 'inline; filename=provider.html',
          'set-cookie': 'provider=secret',
          'x-provider-debug': 'private',
        },
      }),
    })),
    createFolder: vi.fn(), upload: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(),
  };
}

describe('shared storage targets', () => {
  it('resolves a private native R2 target and lists children with sealed read-only IDs', async () => {
    await insertNativeTree();
    await expect(resolveShareCreationTarget(workerEnv(), 'private-folder')).resolves.toEqual({
      mountId: 'native-r2',
      providerItemId: 'private-folder',
      targetKind: 'folder',
      name: 'Private folder',
    });

    const share = shareFor('native-r2', 'private-folder', 'folder', 'Private folder');
    const directory = await listSharedFolder(workerEnv(), share, null);
    expect(directory.current).toMatchObject({ name: 'Private folder', kind: 'folder' });
    expect(directory.items).toHaveLength(1);
    expect(directory.items[0]).toMatchObject({
      name: 'private.txt',
      capabilities: { open: false, preview: true, download: false, upload: false, rename: false, delete: false },
    });
    expect(JSON.stringify(directory)).not.toContain('private-child');
    await expect(openShareItem(workerEnv(), share.id, directory.items[0].id)).resolves.toBe('private-child');
  });

  it('streams private native R2 files with Range support through a sealed handle', async () => {
    await insertNativeTree();
    const share = shareFor('native-r2', 'private-folder', 'folder', 'Private folder');
    const directory = await listSharedFolder(workerEnv(), share, null);
    const response = await downloadSharedFile(
      workerEnv(),
      share,
      directory.items[0].id,
      new Request('https://ilist.example/s/token/file/handle/private.txt', { headers: { range: 'bytes=0-6' } }),
      false,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe('private');
  });

  it('resolves and browses external targets without exposing provider item IDs', async () => {
    const mount = await createMount(workerEnv().DB, {
      name: 'External', mountPath: '/external-share', driverType: 's3', provider: 'custom', config: {},
    });
    const driver = fakeDriver();
    const registry: DriverRegistry = { s3: () => driver };
    const entryId = encodeExternalId(mount.id, 'provider-folder');

    await expect(resolveShareCreationTarget(workerEnv(), entryId, registry)).resolves.toEqual({
      mountId: mount.id,
      providerItemId: 'provider-folder',
      targetKind: 'folder',
      name: 'External folder',
    });
    const share = shareFor(mount.id, 'provider-folder', 'folder', 'External folder');
    const directory = await listSharedFolder(workerEnv(), share, null, registry);
    expect(directory.items[0]).toMatchObject({
      name: 'external.txt',
      effectivePublic: false,
      exportOptions: [
        { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' },
      ],
    });
    expect(JSON.stringify(directory)).not.toContain('provider-file-secret');

    const resolved = await resolveSharedItem(workerEnv(), share, directory.items[0].id, registry);
    expect(resolved.item.id).toBe('provider-file-secret');
    const response = await downloadSharedFile(
      workerEnv(), share, directory.items[0].id,
      new Request('https://ilist.example/s/token/file/handle/external.txt'), false, registry,
    );
    await expect(response.text()).resolves.toBe('external');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-provider-debug')).toBeNull();
  });
});
