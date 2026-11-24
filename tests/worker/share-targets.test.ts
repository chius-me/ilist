import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DriverRegistry, StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { HttpError } from '../../src/worker/http';
import { createMount } from '../../src/worker/mounts';
import { sealShareItem } from '../../src/worker/share-crypto';
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

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function legacyV1Handle(shareId: string, itemId: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(`ilist:share-item:v1:${workerEnv().SESSION_SECRET}`));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(shareId) },
    key,
    encoder.encode(JSON.stringify({ v: 1, itemId })),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
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
    authRevision: 1,
    expiresAt: null,
    allowDownload: false,
    enabled: true,
    downloadCount: 0,
    maxDownloads: null,
    accessCount: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
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
    isWithin: vi.fn(async (itemId, ancestorId) => {
      if (itemId === ancestorId) return true;
      return itemId === file.id && ancestorId === folder.id;
    }),
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
    copy: vi.fn(async () => { throw new Error('not implemented'); }),
  };
}

describe('shared storage targets', () => {
  it('applies live ancestry checks to legacy v1 handles on external mounts', async () => {
    const mount = await createMount(workerEnv().DB, {
      name: 'Legacy V1 External', mountPath: `/legacy-v1-${crypto.randomUUID()}`, driverType: 's3', provider: 'custom', config: {},
    });
    const driver = fakeDriver();
    const registry: DriverRegistry = { s3: () => driver };
    const share = shareFor(mount.id, 'provider-folder', 'folder', 'External folder');
    const handle = await legacyV1Handle(share.id, 'provider-file-secret');

    await expect(resolveSharedItem(workerEnv(), share, handle, registry)).resolves.toMatchObject({
      item: { id: 'provider-file-secret' },
    });

    driver.isWithin = vi.fn(async () => false);
    await expect(resolveSharedItem(workerEnv(), share, handle, registry)).rejects.toMatchObject({
      status: 404,
      code: 'SHARE_TARGET_MISSING',
    });
  });

  it('reports capabilities.download as false when maxDownloads is exhausted', async () => {
    const mount = await createMount(workerEnv().DB, {
      name: 'Exhausted Quota', mountPath: `/exhausted-${crypto.randomUUID()}`, driverType: 's3', provider: 'custom', config: {},
    });
    const registry: DriverRegistry = { s3: () => fakeDriver() };
    const share: Share = {
      ...shareFor(mount.id, 'provider-folder', 'folder', 'External folder'),
      allowDownload: true,
      maxDownloads: 2,
      downloadCount: 2,
    };

    const directory = await listSharedFolder(workerEnv(), share, null, registry);
    expect(directory.items[0]?.capabilities.download).toBe(false);
    expect(directory.items[0]?.capabilities.preview).toBe(true);
  });

  it('rejects retired native-r2 share mounts as unavailable', async () => {
    const share = shareFor('native-r2', 'provider-folder', 'folder', 'Retired folder');
    await expect(resolveSharedItem(workerEnv(), share, null)).rejects.toMatchObject({
      status: 503,
      code: 'SHARE_PROVIDER_UNAVAILABLE',
    });
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
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-provider-debug')).toBeNull();
  });

  it('rechecks external ancestry and rejects cross-share handle replay', async () => {
    const mount = await createMount(workerEnv().DB, {
      name: 'Mutable external', mountPath: `/mutable-${crypto.randomUUID()}`, driverType: 's3', provider: 'custom', config: {},
    });
    let inside = true;
    const driver = fakeDriver();
    driver.isWithin = vi.fn(async (itemId, ancestorId) => itemId === ancestorId || (inside && itemId === 'provider-file-secret' && ancestorId === 'provider-folder'));
    const registry: DriverRegistry = { s3: () => driver };
    const share = shareFor(mount.id, 'provider-folder', 'folder', 'External folder');
    const handle = (await listSharedFolder(workerEnv(), share, null, registry)).items[0]!.id;

    inside = false;
    await expect(resolveSharedItem(workerEnv(), share, handle, registry)).rejects.toMatchObject({
      status: 404,
      code: 'SHARE_TARGET_MISSING',
    });
    inside = true;
    await expect(resolveSharedItem(workerEnv(), share, handle, registry)).resolves.toMatchObject({ item: { id: 'provider-file-secret' } });

    const otherShare = { ...share, id: 'another-share' };
    await expect(resolveSharedItem(workerEnv(), otherShare, handle, registry)).rejects.toMatchObject({
      status: 400,
      code: 'SHARE_ITEM_INVALID',
    });

    const wrongRoot = await sealShareItem(workerEnv(), share.id, 'other-root', 'provider-file-secret');
    await expect(resolveSharedItem(workerEnv(), share, wrongRoot, registry)).rejects.toMatchObject({
      status: 404,
      code: 'SHARE_TARGET_MISSING',
    });
  });

  it('preserves provider authorization and availability errors during ancestry checks', async () => {
    const mount = await createMount(workerEnv().DB, {
      name: 'Unavailable external', mountPath: `/unavailable-${crypto.randomUUID()}`, driverType: 's3', provider: 'custom', config: {},
    });
    const share = shareFor(mount.id, 'provider-folder', 'folder', 'External folder');
    const handle = await sealShareItem(workerEnv(), share.id, share.providerItemId, 'provider-file-secret');
    for (const status of [403, 503]) {
      const driver = fakeDriver();
      driver.isWithin = vi.fn(async () => {
        throw new HttpError(status, 'PROVIDER_FAILURE', 'Provider failure');
      });
      await expect(resolveSharedItem(workerEnv(), share, handle, { s3: () => driver })).rejects.toMatchObject({ status });
    }
  });
});
