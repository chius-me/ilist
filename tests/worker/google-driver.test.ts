import { describe, expect, it, vi } from 'vitest';
import type { GoogleFile, GoogleListResult } from '../../src/worker/drivers/google/client';
import { GoogleDriveDriver, type GoogleDriveDriverClient } from '../../src/worker/drivers/google/driver';
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_FOLDER_MIME_TYPE } from '../../src/worker/drivers/google/items';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { Mount } from '../../src/worker/types';

const mount: Mount = {
  id: 'mount-google', name: 'My Drive', mountPath: '/google', driverType: 'google', provider: 'google',
  enabled: true, isPublic: true, sortOrder: 0, rootItemId: null, config: {},
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
};

function file(overrides: Partial<GoogleFile> = {}): GoogleFile {
  return {
    id: 'file-1', name: 'file.txt', mimeType: 'text/plain', size: '4',
    modifiedTime: '2026-07-18T00:00:00.000Z', parents: ['root'],
    ...overrides,
  };
}

function client(overrides: Partial<GoogleDriveDriverClient> = {}): GoogleDriveDriverClient {
  return {
    list: vi.fn(async (): Promise<GoogleListResult> => ({ items: [], nextCursor: null })),
    stat: vi.fn(async (id) => file({ id })),
    download: vi.fn(async () => new Response('downloaded', { headers: { 'content-type': 'text/plain' } })),
    exportFile: vi.fn(async () => new Response('exported', { headers: { 'content-type': 'application/pdf' } })),
    createFolder: vi.fn(async (_parentId, name) => file({ id: 'folder-new', name, mimeType: GOOGLE_FOLDER_MIME_TYPE, size: undefined })),
    upload: vi.fn(async (_parentId, name) => file({ id: 'file-new', name })),
    rename: vi.fn(async (id, name) => file({ id, name })),
    move: vi.fn(async (id, destinationId) => file({ id, parents: [destinationId] })),
    trash: vi.fn(async (id) => file({ id, trashed: true })),
    ...overrides,
  };
}

describe('Google Drive storage driver', () => {
  it('maps lists and exposes supported non-resumable capabilities', async () => {
    const api = client({
      list: vi.fn(async () => ({
        items: [file(), file({ id: 'folder', name: 'Folder', mimeType: GOOGLE_FOLDER_MIME_TYPE, size: undefined })],
        nextCursor: 'next-page',
      })),
    });
    const driver = new GoogleDriveDriver(mount, api);

    await expect(driver.list('root')).resolves.toMatchObject({
      items: [{ id: 'file-1', parentId: 'root', kind: 'file' }, { id: 'folder', parentId: 'root', kind: 'folder' }],
      nextCursor: 'next-page',
    });
    expect(driver.rootId).toBe('root');
    expect(driver.capabilities).toEqual(new Set(['list', 'download', 'upload', 'createFolder', 'rename', 'move', 'delete']));
    expect(driverRegistry.google).toBeTypeOf('function');
  });

  it('streams ordinary files with Range and requires explicit supported Workspace exports', async () => {
    const stat = vi.fn(async (id: string) => id === 'doc'
      ? file({ id, name: 'Report', mimeType: GOOGLE_DOC_MIME_TYPE, size: undefined })
      : file({ id }));
    const api = client({ stat });
    const driver = new GoogleDriveDriver(mount, api);

    const ordinary = await driver.getDownload('file-1', new Request('https://ilist.example/file', {
      headers: { range: 'bytes=1-2' },
    }));
    expect(ordinary.kind).toBe('stream');
    expect(api.download).toHaveBeenCalledWith('file-1', 'bytes=1-2');

    await expect(driver.getDownload('doc', new Request('https://ilist.example/file')))
      .rejects.toMatchObject({ code: 'GOOGLE_EXPORT_REQUIRED' });
    await expect(driver.getDownload('doc', new Request('https://ilist.example/file?export=zip')))
      .rejects.toMatchObject({ code: 'GOOGLE_EXPORT_UNSUPPORTED' });
    const exported = await driver.getDownload('doc', new Request('https://ilist.example/file?export=pdf'));
    expect(exported.kind).toBe('stream');
    expect(api.exportFile).toHaveBeenCalledWith('doc', 'application/pdf');
  });

  it('delegates create, streamed upload, rename, move, and trash operations', async () => {
    const api = client();
    const driver = new GoogleDriveDriver(mount, api);
    const body = new ReadableStream();

    await driver.createFolder('root', '项目');
    await driver.upload('root', '文件.txt', body, 'text/plain');
    await driver.rename('file-1', 'renamed.txt');
    await driver.move('file-1', 'destination');
    await driver.remove('file-1');

    expect(api.createFolder).toHaveBeenCalledWith('root', '项目');
    expect(api.upload).toHaveBeenCalledWith('root', '文件.txt', body, 'text/plain');
    expect(api.rename).toHaveBeenCalledWith('file-1', 'renamed.txt');
    expect(api.move).toHaveBeenCalledWith('file-1', 'destination');
    expect(api.trash).toHaveBeenCalledWith('file-1');
  });

  it('rejects reads and mutations outside a configured mount sub-root', async () => {
    const scoped = { ...mount, rootItemId: 'mounted-root' };
    const stat = vi.fn(async (id: string) => {
      if (id === 'mounted-root') return file({ id, mimeType: GOOGLE_FOLDER_MIME_TYPE, size: undefined, parents: ['drive-root'] });
      if (id === 'inside') return file({ id, parents: ['mounted-root'] });
      if (id === 'inside-folder') return file({ id, mimeType: GOOGLE_FOLDER_MIME_TYPE, size: undefined, parents: ['mounted-root'] });
      if (id === 'outside') return file({ id, parents: ['other-folder'] });
      return file({ id, mimeType: GOOGLE_FOLDER_MIME_TYPE, size: undefined, parents: ['drive-root'] });
    });
    const api = client({ stat });
    const driver = new GoogleDriveDriver(scoped, api);

    await expect(driver.stat('inside')).resolves.toMatchObject({ id: 'inside' });
    await expect(driver.getDownload('outside', new Request('https://ilist.example/file')))
      .rejects.toMatchObject({ code: 'STORAGE_ITEM_NOT_FOUND' });
    await expect(driver.move('inside', 'outside')).rejects.toMatchObject({ code: 'STORAGE_ITEM_NOT_FOUND' });
    await expect(driver.remove('outside')).rejects.toMatchObject({ code: 'STORAGE_ITEM_NOT_FOUND' });
    expect(api.move).not.toHaveBeenCalled();
    expect(api.trash).not.toHaveBeenCalled();
  });

  it('protects the mount root and validates provider-safe names', async () => {
    const driver = new GoogleDriveDriver(mount, client());

    await expect(driver.rename('root', 'renamed')).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
    await expect(driver.move('root', 'destination')).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
    await expect(driver.remove('root')).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
    await expect(driver.createFolder('root', '../bad')).rejects.toMatchObject({ code: 'INVALID_ENTRY_NAME' });
  });
});
