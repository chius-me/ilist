import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { putCredentials } from '../../src/worker/credentials';
import { createMount } from '../../src/worker/mounts';
import { OneDriveClient, type GraphDriveItem, type GraphListResult } from '../../src/worker/drivers/onedrive/client';
import { OneDriveDriver, type OneDriveDriverClient } from '../../src/worker/drivers/onedrive/driver';
import { mapGraphItem } from '../../src/worker/drivers/onedrive/mapper';
import type { Env, Mount } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;
const mount: Mount = {
  id: 'mount-onedrive', name: 'Personal', mountPath: '/personal', driverType: 'onedrive',
  provider: 'microsoft-onedrive-personal', enabled: true, isPublic: true, sortOrder: 0,
  rootItemId: 'root', config: {}, createdAt: '2026-07-15T00:00:00Z', updatedAt: '2026-07-15T00:00:00Z',
};

function graphItem(overrides: Partial<GraphDriveItem> = {}): GraphDriveItem {
  return {
    id: 'item-1', name: '文档.txt', size: 12, lastModifiedDateTime: '2026-07-15T01:02:03Z',
    eTag: 'etag-1', parentReference: { id: 'parent-1' }, file: { mimeType: 'text/plain' },
    ...overrides,
  };
}

function driverClient(overrides: Partial<OneDriveDriverClient> = {}): OneDriveDriverClient {
  return {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    stat: vi.fn(async () => graphItem()),
    getDownloadUrl: vi.fn(async () => 'https://download.example/default'),
    createFolder: vi.fn(async () => graphItem({ id: 'new-folder', file: undefined, folder: { childCount: 0 } })),
    upload: vi.fn(async () => graphItem({ id: 'new-file' })),
    update: vi.fn(async () => graphItem()),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('OneDrive read driver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps files, folders, and packages without losing Unicode metadata', () => {
    expect(mapGraphItem(graphItem(), null)).toMatchObject({
      id: 'item-1', parentId: 'parent-1', name: '文档.txt', kind: 'file', size: 12, contentType: 'text/plain', etag: 'etag-1',
    });
    expect(mapGraphItem(graphItem({ id: 'folder', file: undefined, folder: { childCount: 2 }, parentReference: undefined }), 'root')).toMatchObject({
      id: 'folder', parentId: 'root', kind: 'folder', size: null,
    });
    expect(mapGraphItem(graphItem({ id: 'notebook', file: undefined, package: { type: 'oneNote' } }), 'root')).toMatchObject({
      id: 'notebook', kind: 'folder', contentType: null,
    });
    expect(mapGraphItem({ id: 'drive-root', name: 'OneDrive', root: {} } as GraphDriveItem, null)).toMatchObject({
      id: 'drive-root', kind: 'folder', parentId: null,
    });
    expect(mapGraphItem({ id: 'vault', name: 'Personal Vault', specialFolder: { name: 'vault' } } as GraphDriveItem, 'root')).toMatchObject({
      id: 'vault', kind: 'folder', parentId: 'root',
    });
  });

  it('lists root and child items while preserving opaque nextLink cursors', async () => {
    const api = driverClient({
      list: vi.fn(async (parentId, cursor) => ({
        items: [graphItem(), { id: 'vault', name: 'Personal Vault', size: 0 }],
        nextCursor: cursor ? null : 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=opaque',
      })),
    });
    const driver = new OneDriveDriver(mount, api);

    const root = await driver.list(driver.rootId);
    const child = await driver.list('folder-id', root.nextCursor!);

    expect(api.list).toHaveBeenNthCalledWith(1, 'root', undefined);
    expect(api.list).toHaveBeenNthCalledWith(2, 'folder-id', root.nextCursor);
    expect(root.items[0]).toMatchObject({ name: '文档.txt', kind: 'file' });
    expect(root.items).toHaveLength(1);
    expect(child.nextCursor).toBeNull();
  });

  it('fetches a fresh preauthenticated download URL and rejects folder downloads', async () => {
    const stat = vi.fn()
      .mockResolvedValueOnce(graphItem())
      .mockResolvedValueOnce(graphItem({ id: 'folder', file: undefined, folder: { childCount: 1 } }));
    const getDownloadUrl = vi.fn(async () => 'https://download.example/one');
    const driver = new OneDriveDriver(mount, driverClient({ stat, getDownloadUrl }));

    await expect(driver.getDownload('item-1', new Request('https://ilist.example/file'))).resolves.toEqual({
      kind: 'redirect', url: 'https://download.example/one',
    });
    await expect(driver.getDownload('folder', new Request('https://ilist.example/file'))).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
    expect(stat).toHaveBeenCalledTimes(2);
    expect(getDownloadUrl).toHaveBeenCalledOnce();
    expect(getDownloadUrl).toHaveBeenCalledWith('item-1');
  });

  it('rejects item IDs outside a configured OneDrive sub-root', async () => {
    const scopedMount = { ...mount, rootItemId: 'mounted-root' };
    const stat = vi.fn(async (id: string) => {
      if (id === 'mounted-root') return graphItem({ id, name: 'Mounted', file: undefined, folder: { childCount: 1 }, parentReference: { id: 'drive-root' } });
      if (id === 'inside') return graphItem({ id, parentReference: { id: 'mounted-root' }, '@microsoft.graph.downloadUrl': 'https://download.example/inside' });
      if (id === 'outside') return graphItem({ id, parentReference: { id: 'other-folder' }, '@microsoft.graph.downloadUrl': 'https://download.example/outside' });
      return graphItem({ id, parentReference: { id: 'drive-root' }, file: undefined, folder: { childCount: 1 } });
    });
    const api = driverClient({ stat });
    const driver = new OneDriveDriver(scopedMount, api);

    await expect(driver.stat('inside')).resolves.toMatchObject({ id: 'inside' });
    await expect(driver.getDownload('outside', new Request('https://ilist.example/file'))).rejects.toMatchObject({
      status: 404,
      code: 'STORAGE_ITEM_NOT_FOUND',
    });
    await expect(driver.remove('outside')).rejects.toMatchObject({ code: 'STORAGE_ITEM_NOT_FOUND' });
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('uses encoded Graph item paths and only accepts Graph nextLink cursors', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/items/child/children?$skiptoken=next' }));
    const client = new OneDriveClient(workerEnv(), mount.id, fetcher, async () => 'test-access');

    const result = await client.list('folder/id ?', undefined);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/me/drive/items/folder%2Fid%20%3F/children');
    expect(result.nextCursor).toContain('$skiptoken=next');
    await expect(client.list('root', 'https://attacker.example/steal')).rejects.toMatchObject({ code: 'INVALID_ONEDRIVE_CURSOR' });
  });

  it('invokes the Graph fetcher with the Worker global as its receiver', async () => {
    let calledWithWorkerGlobal = false;
    async function fetcher(this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      calledWithWorkerGlobal = this === globalThis;
      return Response.json({ value: [] });
    }
    const client = new OneDriveClient(workerEnv(), mount.id, fetcher, async () => 'test-access');

    await client.list('root');

    expect(calledWithWorkerGlobal).toBe(true);
  });

  it('gets a download URL from the Graph content endpoint without following the redirect', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: 'https://public.dm.files.1drv.com/download' },
    }));
    const client = new OneDriveClient(workerEnv(), mount.id, fetcher, async () => 'test-access');

    await expect(client.getDownloadUrl('item/id')).resolves.toBe('https://public.dm.files.1drv.com/download');
    expect(String(fetcher.mock.calls[0]![0])).toContain('/me/drive/items/item%2Fid/content');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer test-access');
  });

  it('maps Graph errors and retries one 401 with a refreshed access token', async () => {
    const created = await createMount(workerEnv().DB, {
      name: `Read retry ${crypto.randomUUID()}`, mountPath: `/read-${crypto.randomUUID()}`,
      driverType: 'onedrive', provider: 'microsoft-onedrive-personal', config: {},
    });
    await putCredentials(workerEnv(), created.id, {
      accessToken: 'stale-access', refreshToken: 'refresh-1', tokenType: 'Bearer',
      expiresAt: Date.now() + 10 * 60_000, scope: 'offline_access User.Read Files.ReadWrite',
    });
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.includes('/oauth2/v2.0/token')) return Response.json({
        token_type: 'Bearer', access_token: 'fresh-access', refresh_token: 'refresh-2', expires_in: 3600,
      });
      if (calls.filter((call) => call.url.includes('graph.microsoft.com')).length === 1) {
        return Response.json({ error: { code: 'InvalidAuthenticationToken', message: 'token details' } }, { status: 401 });
      }
      return Response.json({ value: [] });
    });
    const client = new OneDriveClient(workerEnv(), created.id, fetcher);

    await expect(client.list('root')).resolves.toEqual({ items: [], nextCursor: null });
    expect(calls.filter((call) => call.url.includes('graph.microsoft.com')).map((call) => call.authorization))
      .toEqual(['Bearer stale-access', 'Bearer fresh-access']);

    const denied = new OneDriveClient(workerEnv(), created.id, vi.fn(async () => Response.json({
      error: { code: 'accessDenied', message: 'private upstream detail' },
    }, { status: 403 })));
    const error = await denied.stat('missing').catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 403, code: 'ONEDRIVE_ACCESS_DENIED' });
    expect(String(error)).not.toContain('private upstream detail');
  });

  it('delegates create, streamed upload, rename, move, and delete through the common driver contract', async () => {
    const api = driverClient();
    const driver = new OneDriveDriver(mount, api);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } });

    await expect(driver.createFolder(driver.rootId, '项目')).resolves.toMatchObject({ id: 'new-folder', kind: 'folder' });
    await expect(driver.upload('folder-id', '文件.txt', stream, 'text/plain')).resolves.toMatchObject({ id: 'new-file', kind: 'file' });
    await driver.rename('item-1', 'renamed.txt');
    await driver.move('item-1', 'destination');
    await driver.remove('item-1');

    expect(api.createFolder).toHaveBeenCalledWith('root', '项目');
    expect(api.upload).toHaveBeenCalledWith('folder-id', '文件.txt', stream, 'text/plain');
    expect(api.update).toHaveBeenNthCalledWith(1, 'item-1', { name: 'renamed.txt' });
    expect(api.update).toHaveBeenNthCalledWith(2, 'item-1', { parentReference: { id: 'destination' } });
    expect(api.remove).toHaveBeenCalledWith('item-1');
    expect(driver.capabilities).toEqual(new Set(['list', 'download', 'upload', 'createFolder', 'rename', 'move', 'delete']));
  });

  it('sends correctly encoded Graph write requests and preserves streamed bodies', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json(graphItem({ id: 'written' }));
    });
    const client = new OneDriveClient(workerEnv(), mount.id, fetcher, async () => 'test-access');
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([7])); controller.close(); } });

    await client.createFolder('root', '新目录');
    await client.upload('parent/id', '空 格.txt', stream, 'text/plain');
    await client.update('item/id', { name: '新名称.txt' });
    await client.update('item/id', { parentReference: { id: 'new-parent' } });
    await client.remove('item/id');

    expect(calls[0]!.url).toContain('/me/drive/root/children');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: '新目录', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
    expect(calls[1]!.url).toContain('/me/drive/items/parent%2Fid:/%E7%A9%BA%20%E6%A0%BC.txt:/content');
    expect(new URL(calls[1]!.url).searchParams.get('@microsoft.graph.conflictBehavior')).toBe('fail');
    expect(calls[1]!.init).toMatchObject({ method: 'PUT', body: stream });
    expect(calls[2]!.url).toContain('/me/drive/items/item%2Fid');
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ parentReference: { id: 'new-parent' } });
    expect(calls[4]!.init.method).toBe('DELETE');
  });
});
