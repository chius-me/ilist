import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { decodeExternalId } from '../../src/worker/external-identity';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const originalOneDriveFactory = driverRegistry.onedrive;
const originalS3Factory = driverRegistry.s3;
const originalGoogleFactory = driverRegistry.google;

function item(input: Partial<StorageItem> & Pick<StorageItem, 'id' | 'name' | 'kind'>): StorageItem {
  return {
    parentId: null,
    size: input.kind === 'file' ? 5 : null,
    contentType: input.kind === 'file' ? 'text/plain' : null,
    modifiedAt: '2026-07-15T00:00:00.000Z',
    etag: 'etag',
    ...input,
  };
}

function fakeDriver(label: string, resumable = false): StorageDriver {
  const children = new Map<string, StorageItem[]>([
    ['root', [item({ id: 'shared-folder-id', parentId: 'root', name: 'Docs', kind: 'folder' })]],
    ['shared-folder-id', [item({ id: 'same-provider-id', parentId: 'shared-folder-id', name: `${label}.txt`, kind: 'file' })]],
  ]);
  const add = (entry: StorageItem) => {
    children.set(entry.parentId ?? 'root', [...(children.get(entry.parentId ?? 'root') ?? []), entry]);
    return entry;
  };
  return {
    rootId: 'root',
    capabilities: new Set([
      'list', 'download', 'upload', 'createFolder', 'rename', 'move', 'delete',
      ...(resumable ? ['multipartUpload' as const] : []),
    ]),
    isWithin: vi.fn(async (itemId, ancestorId) => {
      if (itemId === ancestorId) return true;
      let current = [...children.values()].flat().find((entry) => entry.id === itemId);
      const visited = new Set<string>();
      while (current?.parentId && !visited.has(current.id)) {
        if (current.parentId === ancestorId) return true;
        visited.add(current.id);
        current = [...children.values()].flat().find((entry) => entry.id === current!.parentId);
      }
      return false;
    }),
    ...(resumable ? {
      resumableUpload: {
        create: vi.fn(async () => ({ state: {}, expiresAt: Date.now() + 60_000 })),
        uploadPart: vi.fn(async () => ({ part: { partNumber: 1, size: 0, etag: null } })),
        complete: vi.fn(async () => item({ id: `upload-${label}`, parentId: 'root', name: 'completed.txt', kind: 'file' })),
        abort: vi.fn(async () => undefined),
      },
    } : {}),
    list: vi.fn(async (parentId) => ({ items: children.get(parentId) ?? [], nextCursor: null })),
    stat: vi.fn(async (id) => {
      if (id === 'root') return item({ id: 'root', name: label, kind: 'folder' });
      const found = [...children.values()].flat().find((entry) => entry.id === id);
      if (!found) throw new Error('not found');
      return found;
    }),
    getDownload: vi.fn(async () => ({ kind: 'redirect' as const, url: `https://download.example/${label}` })),
    createFolder: vi.fn(async (parentId, name) => add(item({ id: `folder-${label}`, parentId, name, kind: 'folder' }))),
    upload: vi.fn(async (parentId, name) => add(item({ id: `upload-${label}`, parentId, name, kind: 'file' }))),
    rename: vi.fn(async (id, name) => item({ id, parentId: 'root', name, kind: 'file' })),
    move: vi.fn(async (id, destinationId) => item({ id, parentId: destinationId, name: `${label}.txt`, kind: 'file' })),
    remove: vi.fn(async () => undefined),
  };
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '127.0.0.1', 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

afterEach(() => {
  driverRegistry.onedrive = originalOneDriveFactory;
  driverRegistry.s3 = originalS3Factory;
  driverRegistry.google = originalGoogleFactory;
});

describe('multi-mount filesystem integration', () => {
  it('isolates identical Google provider item IDs across independent mounts', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    const personal = await createMount(db, {
      name: 'Google Personal', mountPath: '/google-personal', driverType: 'google', provider: 'google',
      isPublic: true,
    });
    const archive = await createMount(db, {
      name: 'Google Archive', mountPath: '/google-archive', driverType: 'google', provider: 'google',
      isPublic: true,
    });
    const drivers = new Map([[personal.id, fakeDriver('google-personal')], [archive.id, fakeDriver('google-archive')]]);
    driverRegistry.google = (_env, mount) => drivers.get(mount.id)!;

    const personalResponse = await SELF.fetch(`${origin}/api/fs/list?path=/google-personal/Docs`);
    const archiveResponse = await SELF.fetch(`${origin}/api/fs/list?path=/google-archive/Docs`);
    expect(personalResponse.status).toBe(200);
    expect(archiveResponse.status).toBe(200);
    const personalEntry = (await personalResponse.json() as { data: { items: Array<{ id: string; name: string }> } }).data.items[0];
    const archiveEntry = (await archiveResponse.json() as { data: { items: Array<{ id: string; name: string }> } }).data.items[0];

    expect(personalEntry.name).toBe('google-personal.txt');
    expect(archiveEntry.name).toBe('google-archive.txt');
    expect(personalEntry.id).not.toBe(archiveEntry.id);
    expect(decodeExternalId(personalEntry.id)).toEqual({ mountId: personal.id, itemId: 'same-provider-id' });
    expect(decodeExternalId(archiveEntry.id)).toEqual({ mountId: archive.id, itemId: 'same-provider-id' });
  });

  it('advertises resumable uploads only for authenticated external folders with a provider adapter', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    await createMount(db, { name: 'Personal', mountPath: '/personal', driverType: 'onedrive', provider: 'onedrive', isPublic: true });
    const driver = fakeDriver('personal', true);
    driverRegistry.onedrive = () => driver;
    const cookie = await login();

    const adminResponse = await SELF.fetch(`${origin}/api/fs/list?path=/personal`, { headers: { cookie } });
    expect(adminResponse.status).toBe(200);
    const folder = (await adminResponse.json() as { data: { items: Array<{ capabilities: Record<string, boolean> }> } }).data.items[0];
    expect(folder.capabilities).toMatchObject({
      upload: true,
      multipartUpload: true,
    });

    const publicResponse = await SELF.fetch(`${origin}/api/fs/list?path=/personal`);
    expect(publicResponse.status).toBe(200);
    const publicFolder = (await publicResponse.json() as { data: { items: Array<{ capabilities: Record<string, boolean> }> } }).data.items[0];
    expect(publicFolder.capabilities.multipartUpload).toBe(false);

    const nativeResponse = await SELF.fetch(`${origin}/api/fs/list?path=/R2`, { headers: { cookie } });
    expect(nativeResponse.status).toBe(200);
    const nativeRoot = (await nativeResponse.json() as { data: { current: { capabilities: Record<string, boolean> } } }).data.current;
    expect(nativeRoot.capabilities.multipartUpload).toBe(false);

    const listed = await SELF.fetch(`${origin}/api/fs/list?path=/personal`, { headers: { cookie } });
    const uploadFolder = (await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0];
    const smallUpload = await SELF.fetch(
      `${origin}/api/admin/files/small-upload?parentId=${encodeURIComponent(uploadFolder.id)}&name=small.txt`,
      { method: 'PUT', headers: { cookie, origin, 'content-type': 'text/plain' }, body: 'small' },
    );
    expect(smallUpload.status).toBe(200);
    expect(driver.upload).toHaveBeenCalledWith('shared-folder-id', 'small.txt', expect.anything(), 'text/plain');
    expect(driver.resumableUpload?.create).not.toHaveBeenCalled();
  });

  it('browses two mounts with collision-free IDs and downloads through the selected driver', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    const first = await createMount(db, { name: 'Personal', mountPath: '/personal', driverType: 'onedrive', provider: 'onedrive', isPublic: true });
    const second = await createMount(db, { name: 'Archive', mountPath: '/archive', driverType: 'onedrive', provider: 'onedrive', isPublic: true });
    const drivers = new Map([[first.id, fakeDriver('personal')], [second.id, fakeDriver('archive')]]);
    driverRegistry.onedrive = (_env, mount) => drivers.get(mount.id)!;

    const personal = await SELF.fetch(`${origin}/api/fs/list?path=/personal/Docs`);
    const archive = await SELF.fetch(`${origin}/api/fs/list?path=/archive/Docs`);
    expect(personal.status).toBe(200);
    expect(archive.status).toBe(200);
    const personalEntry = (await personal.json() as { data: { items: Array<{ id: string; mountId: string }> } }).data.items[0];
    const archiveEntry = (await archive.json() as { data: { items: Array<{ id: string; mountId: string }> } }).data.items[0];

    expect(personalEntry.id).not.toBe(archiveEntry.id);
    expect(personalEntry.mountId).toBe(first.id);
    expect(decodeExternalId(personalEntry.id)).toEqual({ mountId: first.id, itemId: 'same-provider-id' });

    const download = await SELF.fetch(`${origin}/file/${personalEntry.id}/personal.txt`, { redirect: 'manual' });
    expect(download.status).toBe(302);
    expect(download.headers.get('location')).toBe('https://download.example/personal');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
  });

  it('dispatches admin create, upload, rename, move, and delete operations to an external mount', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    const mount = await createMount(db, { name: 'Personal', mountPath: '/personal', driverType: 'onedrive', provider: 'onedrive' });
    const driver = fakeDriver('personal');
    driverRegistry.onedrive = () => driver;
    const cookie = await login();
    const listed = await SELF.fetch(`${origin}/api/fs/list?path=/personal`, { headers: { cookie } });
    const folder = (await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0];
    const headers = { cookie, origin, 'content-type': 'application/json' };

    const created = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST', headers, body: JSON.stringify({ parentId: folder.id, name: 'New' }),
    });
    expect(created.status).toBe(200);
    expect(driver.createFolder).toHaveBeenCalledWith('shared-folder-id', 'New');

    const uploaded = await SELF.fetch(`${origin}/api/admin/files/task-id?parentId=${encodeURIComponent(folder.id)}&name=new.txt`, {
      method: 'PUT', headers: { cookie, origin, 'content-type': 'text/plain' }, body: 'hello',
    });
    expect(uploaded.status).toBe(200);
    expect(driver.upload).toHaveBeenCalledWith('shared-folder-id', 'new.txt', expect.anything(), 'text/plain');
    const uploadedId = (await uploaded.json() as { data: { id: string } }).data.id;

    const renamed = await SELF.fetch(`${origin}/api/admin/entries/${uploadedId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'renamed.txt' }),
    });
    expect(renamed.status).toBe(200);
    expect(driver.rename).toHaveBeenCalledWith('upload-personal', 'renamed.txt');

    const moved = await SELF.fetch(`${origin}/api/admin/entries/move`, {
      method: 'POST', headers, body: JSON.stringify({ ids: [uploadedId, uploadedId], destinationId: folder.id }),
    });
    expect(moved.status).toBe(200);
    expect(driver.move).toHaveBeenCalledWith('upload-personal', 'shared-folder-id');

    const removed = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers, body: JSON.stringify({ ids: [uploadedId, uploadedId] }),
    });
    expect(removed.status).toBe(200);
    expect(driver.remove).toHaveBeenCalledWith('upload-personal');
    expect(decodeExternalId(uploadedId)?.mountId).toBe(mount.id);
    expect(driver.move).toHaveBeenCalledTimes(1);
    expect(driver.remove).toHaveBeenCalledTimes(1);
  });

  it('isolates private, disabled, and failing mounts while keeping healthy roots available', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    const healthy = await createMount(db, { name: 'Healthy', mountPath: '/healthy', driverType: 'onedrive', provider: 'onedrive', isPublic: true });
    await createMount(db, { name: 'Private', mountPath: '/private', driverType: 'onedrive', provider: 'onedrive', isPublic: false });
    await createMount(db, { name: 'Disabled', mountPath: '/disabled', driverType: 'onedrive', provider: 'onedrive', enabled: false });
    const failing = await createMount(db, { name: 'Failing', mountPath: '/failing', driverType: 'onedrive', provider: 'onedrive', isPublic: true });
    driverRegistry.onedrive = (_env, mount) => {
      if (mount.id === failing.id) throw new Error('provider unavailable');
      return fakeDriver(mount.id === healthy.id ? 'healthy' : 'private');
    };

    const guestRoot = await SELF.fetch(`${origin}/api/fs/list?path=/`);
    const guestNames = (await guestRoot.json() as { data: { items: Array<{ name: string }> } }).data.items.map((entry) => entry.name);
    expect(guestNames).toEqual(['Failing', 'Healthy', 'R2']);
    const cookie = await login();
    const adminRoot = await SELF.fetch(`${origin}/api/fs/list?path=/`, { headers: { cookie } });
    const adminNames = (await adminRoot.json() as { data: { items: Array<{ name: string }> } }).data.items.map((entry) => entry.name);
    expect(adminNames).toEqual(['Failing', 'Healthy', 'Private', 'R2']);
    expect((await SELF.fetch(`${origin}/api/fs/list?path=/private`)).status).toBe(404);
    expect((await SELF.fetch(`${origin}/api/fs/list?path=/failing`)).status).toBe(500);
    expect((await SELF.fetch(`${origin}/api/fs/list?path=/healthy`)).status).toBe(200);
  });

  it('forces private no-store caching and empty bodies for external HEAD downloads', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    const mount = await createMount(db, { name: 'Private', mountPath: '/private', driverType: 'onedrive', provider: 'onedrive', isPublic: false });
    const driver = fakeDriver('private');
    driver.getDownload = vi.fn(async () => ({
      kind: 'stream' as const,
      response: new Response('provider-body', { headers: {
        'cache-control': 'public, max-age=3600',
        'content-type': 'text/html',
        'content-disposition': 'inline; filename=upstream.html',
        'set-cookie': 'provider=secret',
        'x-provider-debug': 'private',
      } }),
    }));
    driverRegistry.onedrive = () => driver;
    const cookie = await login();
    const listed = await SELF.fetch(`${origin}/api/fs/list?path=/private/Docs`, { headers: { cookie } });
    const entry = (await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0];

    const response = await SELF.fetch(`${origin}/file/${entry.id}/private.txt`, { method: 'HEAD', headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-provider-debug')).toBeNull();
    await expect(response.text()).resolves.toBe('');
  });

  it.each([
    ['s3', 'cloudflare-r2', 'HTML', 'text/html', 'html'],
    ['s3', 'cloudflare-r2', 'SVG', 'image/svg+xml', 'svg'],
    ['google', 'google', 'HTML', 'text/html', 'html'],
    ['google', 'google', 'SVG', 'image/svg+xml', 'svg'],
  ] as const)('secures streamed %s $s downloads at the file route', async (driverType, provider, _label, contentType, extension) => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    await createMount(db, {
      name: `${driverType} streamed`, mountPath: '/streamed', driverType, provider,
      isPublic: true,
    });
    const driver = fakeDriver(driverType);
    driver.getDownload = vi.fn(async () => ({
      kind: 'stream' as const,
      response: new Response('provider-body', {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': 'bytes 0-12/20',
          'content-length': '13',
          'content-type': contentType,
          'content-disposition': `inline; filename=provider.${extension}`,
          'set-cookie': 'provider=secret',
          'x-provider-debug': 'private',
        },
      }),
    }));
    if (driverType === 's3') driverRegistry.s3 = () => driver;
    else driverRegistry.google = () => driver;

    const listed = await SELF.fetch(`${origin}/api/fs/list?path=/streamed/Docs`);
    const entry = (await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0];
    const response = await SELF.fetch(`${origin}/file/${entry.id}/provider.${extension}`, {
      headers: { range: 'bytes=0-12' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-12/20');
    expect(response.headers.get('content-length')).toBe('13');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-provider-debug')).toBeNull();
    await expect(response.text()).resolves.toBe('provider-body');
  });

  it('routes S3-compatible browsing and CRUD through the same mounted filesystem API', async () => {
    const db = (env as unknown as Env).DB;
    await db.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    await createMount(db, {
      name: 'S3 Archive', mountPath: '/s3-archive', driverType: 's3', provider: 'cloudflare-r2',
      isPublic: true,
      config: { endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', bucket: 'archive', addressingMode: 'path' },
    });
    const driver = fakeDriver('s3');
    driverRegistry.s3 = () => driver;
    const cookie = await login();
    const listed = await SELF.fetch(`${origin}/api/fs/list?path=/s3-archive`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    const folder = (await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0];

    const created = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: folder.id, name: 'Created' }),
    });
    expect(created.status).toBe(200);
    const createdId = (await created.json() as { data: { id: string } }).data.id;
    const uploaded = await SELF.fetch(`${origin}/api/admin/files/s3-task?parentId=${encodeURIComponent(folder.id)}&name=archive.txt`, {
      method: 'PUT', headers: { cookie, origin, 'content-type': 'text/plain' }, body: 'hello',
    });
    expect(uploaded.status).toBe(200);
    const uploadedId = (await uploaded.json() as { data: { id: string } }).data.id;
    const download = await SELF.fetch(`${origin}/file/${uploadedId}/archive.txt`, { redirect: 'manual' });
    expect(download.status).toBe(302);
    expect(download.headers.get('location')).toBe('https://download.example/s3');
    const renamed = await SELF.fetch(`${origin}/api/admin/entries/${uploadedId}`, {
      method: 'PATCH', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'renamed.txt' }),
    });
    expect(renamed.status).toBe(200);
    const moved = await SELF.fetch(`${origin}/api/admin/entries/move`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [uploadedId], destinationId: folder.id }),
    });
    expect(moved.status).toBe(200);
    const removed = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [createdId, uploadedId] }),
    });
    expect(removed.status).toBe(200);
    expect(driver.createFolder).toHaveBeenCalledWith('shared-folder-id', 'Created');
    expect(driver.upload).toHaveBeenCalledWith('shared-folder-id', 'archive.txt', expect.anything(), 'text/plain');
    expect(driver.rename).toHaveBeenCalledWith('upload-s3', 'renamed.txt');
    expect(driver.move).toHaveBeenCalledWith('upload-s3', 'shared-folder-id');
    expect(driver.remove).toHaveBeenCalledWith('folder-s3');
    expect(driver.remove).toHaveBeenCalledWith('upload-s3');
  });

  it('preserves native R2 stable links and redirects legacy object paths', async () => {
    const worker = env as unknown as Env;
    const cookie = await login();
    const stableId = `integration-${crypto.randomUUID()}`;
    const uploaded = await SELF.fetch(`${origin}/api/admin/files/${stableId}?parentId=root&name=stable.txt`, {
      method: 'PUT', headers: { cookie, origin, 'content-type': 'text/plain' }, body: 'stable-data',
    });
    expect(uploaded.status).toBe(200);
    const stable = await SELF.fetch(`${origin}/file/${stableId}/ignored.txt`);
    expect(stable.status).toBe(200);
    await expect(stable.text()).resolves.toBe('stable-data');

    const legacyId = `legacy-${crypto.randomUUID()}`;
    const legacyKey = `legacy/${legacyId}.txt`;
    const now = new Date().toISOString();
    await worker.R2_BUCKET.put(legacyKey, 'legacy-data', { httpMetadata: { contentType: 'text/plain' } });
    await worker.DB.prepare(`INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
      VALUES (?, 'legacy.txt', 11, 'text/plain', 'etag', ?, 1, 0, '')`).bind(legacyKey, now).run();
    await worker.DB.prepare(`INSERT INTO entries (
      id, parent_id, name, kind, storage_key, size, content_type, etag, status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
    ) VALUES (?, 'root', 'legacy.txt', 'file', ?, 11, 'text/plain', 'etag', 'ready', NULL, 1, 0, '', ?, ?)`)
      .bind(legacyId, legacyKey, now, now).run();
    const legacy = await SELF.fetch(`${origin}/file/${legacyKey}`, { redirect: 'manual' });
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get('location')).toBe(`/file/${legacyId}/legacy.txt`);
  });
});
