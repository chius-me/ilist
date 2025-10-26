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
  });

  it('lists root and child items while preserving opaque nextLink cursors', async () => {
    const api = driverClient({
      list: vi.fn(async (parentId, cursor) => ({ items: [graphItem()], nextCursor: cursor ? null : 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=opaque' })),
    });
    const driver = new OneDriveDriver(mount, api);

    const root = await driver.list(driver.rootId);
    const child = await driver.list('folder-id', root.nextCursor!);

    expect(api.list).toHaveBeenNthCalledWith(1, 'root', undefined);
    expect(api.list).toHaveBeenNthCalledWith(2, 'folder-id', root.nextCursor);
    expect(root.items[0]).toMatchObject({ name: '文档.txt', kind: 'file' });
    expect(child.nextCursor).toBeNull();
  });

  it('fetches a fresh preauthenticated download URL and rejects folder downloads', async () => {
    const stat = vi.fn()
      .mockResolvedValueOnce(graphItem({ '@microsoft.graph.downloadUrl': 'https://download.example/one' }))
      .mockResolvedValueOnce(graphItem({ id: 'folder', file: undefined, folder: { childCount: 1 } }));
    const driver = new OneDriveDriver(mount, driverClient({ stat }));

    await expect(driver.getDownload('item-1', new Request('https://ilist.example/file'))).resolves.toEqual({
      kind: 'redirect', url: 'https://download.example/one',
    });
    await expect(driver.getDownload('folder', new Request('https://ilist.example/file'))).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('uses encoded Graph item paths and only accepts Graph nextLink cursors', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/items/child/children?$skiptoken=next' }));
    const client = new OneDriveClient(workerEnv(), mount.id, fetcher, async () => 'test-access');

    const result = await client.list('folder/id ?', undefined);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/me/drive/items/folder%2Fid%20%3F/children');
    expect(result.nextCursor).toContain('$skiptoken=next');
    await expect(client.list('root', 'https://attacker.example/steal')).rejects.toMatchObject({ code: 'INVALID_ONEDRIVE_CURSOR' });
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
});
