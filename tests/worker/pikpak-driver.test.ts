import { describe, expect, it, vi } from 'vitest';
import { PikPakDriver } from '../../src/worker/drivers/pikpak/driver';
import type { Mount } from '../../src/worker/types';

const mount: Mount = {
  id: 'pikpak-mount', name: 'PikPak', mountPath: '/pikpak', driverType: 'pikpak', provider: 'pikpak',
  enabled: true, isPublic: false, sortOrder: 0, rootItemId: 'mounted-root', config: { useTrash: true },
  createdAt: '', updatedAt: '',
};

function folder(id: string, parentId: string, name = id) {
  return { id, parent_id: parentId, name, kind: 'drive#folder' as const, modified_time: '2026-01-01T00:00:00Z' };
}

describe('PikPak driver', () => {
  it('paginates listings and maps provider items', async () => {
    const client = {
      stat: vi.fn(async (id: string) => id === 'mounted-root' ? folder(id, 'root') : folder(id, 'mounted-root')),
      list: vi.fn(async () => ({ files: [folder('child', 'mounted-root')], next_page_token: 'next' })),
    };
    const driver = new PikPakDriver(mount, client as never);
    await expect(driver.list('mounted-root', 'cursor')).resolves.toMatchObject({
      items: [{ id: 'child', kind: 'folder', parentId: 'mounted-root' }], nextCursor: 'next',
    });
    expect(client.list).toHaveBeenCalledWith('mounted-root', 'cursor');
  });

  it('enforces the configured root boundary', async () => {
    const client = {
      stat: vi.fn(async (id: string) => {
        if (id === 'inside') return folder(id, 'mounted-root');
        if (id === 'outside') return folder(id, 'other-root');
        if (id === 'other-root') return folder(id, 'root');
        return folder(id, 'root');
      }),
    };
    const driver = new PikPakDriver(mount, client as never);
    await expect(driver.isWithin('inside', 'mounted-root')).resolves.toBe(true);
    await expect(driver.isWithin('outside', 'mounted-root')).resolves.toBe(false);
    await expect(driver.stat('outside')).rejects.toMatchObject({ code: 'STORAGE_ITEM_NOT_FOUND' });
  });

  it('proxies original downloads and forwards Range', async () => {
    const upstream = new Response('part', { status: 206, headers: { 'content-range': 'bytes 0-3/10' } });
    const client = {
      downloadInfo: vi.fn(async (id: string) => ({
        id, parent_id: 'mounted-root', name: 'movie.bin', kind: 'drive#file' as const, size: '10',
        links: { 'application/octet-stream': { url: 'https://download.example/movie.bin' } },
      })),
      download: vi.fn(async () => upstream),
    };
    const driver = new PikPakDriver(mount, client as never);
    const request = new Request('https://ilist.example/file', { headers: { range: 'bytes=0-3' } });
    await expect(driver.getDownload('file-1', request)).resolves.toEqual({ kind: 'stream', response: upstream });
    expect(client.downloadInfo).toHaveBeenCalledWith('file-1');
    expect(client.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), request);
  });

  it('advertises only reliable operations and uses recoverable deletion', async () => {
    const client = {
      stat: vi.fn(async (id: string) => id === 'mounted-root' ? folder(id, 'root') : folder(id, 'mounted-root')),
      remove: vi.fn(async () => undefined),
    };
    const driver = new PikPakDriver(mount, client as never);
    expect(driver.capabilities.has('upload')).toBe(false);
    expect(driver.capabilities.has('copy')).toBe(false);
    await driver.remove('child');
    expect(client.remove).toHaveBeenCalledWith('child', true);
  });
});
