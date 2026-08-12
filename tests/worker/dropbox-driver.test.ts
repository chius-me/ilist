import { describe, expect, it, vi } from 'vitest';
import { DropboxDriver, DROPBOX_ROOT_ID, type DropboxDriverClient } from '../../src/worker/drivers/dropbox/driver';
import type { DropboxMetadata } from '../../src/worker/drivers/dropbox/types';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { Mount } from '../../src/worker/types';

const mount: Mount = {
  id: 'mount-dropbox', name: 'My Dropbox', mountPath: '/dropbox', driverType: 'dropbox', provider: 'dropbox',
  enabled: true, isPublic: true, sortOrder: 0, rootItemId: null, config: {},
  createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z',
};

function metadata(overrides: Partial<DropboxMetadata> = {}): DropboxMetadata {
  return {
    '.tag': 'file', id: 'id:file', name: 'file.txt', path_lower: '/docs/file.txt', path_display: '/Docs/file.txt',
    size: 4, server_modified: '2026-08-12T00:00:00Z', rev: 'rev-1', is_downloadable: true,
    ...overrides,
  };
}

function client(overrides: Partial<DropboxDriverClient> = {}): DropboxDriverClient {
  return {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    stat: vi.fn(async (id) => {
      if (id === '/Docs') return metadata({ '.tag': 'folder', id: 'id:docs', name: 'Docs', path_lower: '/docs', path_display: '/Docs', size: undefined });
      if (id === 'id:dest') return metadata({ '.tag': 'folder', id, name: 'Dest', path_lower: '/dest', path_display: '/Dest', size: undefined });
      return metadata({ id });
    }),
    download: vi.fn(async () => new Response('downloaded')),
    exportFile: vi.fn(async () => new Response('exported')),
    createFolder: vi.fn(async (path) => metadata({ '.tag': 'folder', id: 'id:new-folder', name: path.split('/').pop()!, path_lower: path.toLowerCase(), path_display: path, size: undefined })),
    upload: vi.fn(async (path) => metadata({ id: 'id:uploaded', name: path.split('/').pop()!, path_lower: path.toLowerCase(), path_display: path })),
    move: vi.fn(async (_from, path) => metadata({ name: path.split('/').pop()!, path_lower: path.toLowerCase(), path_display: path })),
    copy: vi.fn(async (_from, path) => metadata({ id: 'id:copy', name: path.split('/').pop()!, path_lower: path.toLowerCase(), path_display: path })),
    remove: vi.fn(async () => undefined),
    createUploadSession: vi.fn(async () => 'private-session'),
    appendUploadSession: vi.fn(async () => undefined),
    finishUploadSession: vi.fn(async (_id, _offset, path) => metadata({ id: 'id:large', name: path.split('/').pop()!, path_lower: path.toLowerCase(), path_display: path })),
    closeUploadSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Dropbox storage driver', () => {
  it('uses a synthetic root and maps paginated file and folder lists', async () => {
    const api = client({
      list: vi.fn(async () => ({
        items: [metadata(), metadata({ '.tag': 'folder', id: 'id:folder', name: 'Folder', path_lower: '/folder', path_display: '/Folder', size: undefined })],
        nextCursor: 'next',
      })),
    });
    const driver = new DropboxDriver(mount, api);
    expect(driver.rootId).toBe(DROPBOX_ROOT_ID);
    await expect(driver.stat(DROPBOX_ROOT_ID)).resolves.toMatchObject({ id: DROPBOX_ROOT_ID, kind: 'folder', parentId: null });
    await expect(driver.list(DROPBOX_ROOT_ID)).resolves.toMatchObject({
      items: [{ id: 'id:file', parentId: DROPBOX_ROOT_ID, kind: 'file' }, { id: 'id:folder', parentId: DROPBOX_ROOT_ID, kind: 'folder' }],
      nextCursor: 'next',
    });
    expect(api.list).toHaveBeenCalledWith('', undefined);
    expect(driverRegistry.dropbox).toBeTypeOf('function');
  });

  it('delegates path-based mutations while retaining stable ids', async () => {
    const api = client();
    const driver = new DropboxDriver(mount, api);
    await driver.createFolder(DROPBOX_ROOT_ID, 'Projects');
    await driver.upload(DROPBOX_ROOT_ID, 'notes.txt', new ReadableStream(), 'text/plain');
    await driver.rename('id:file', 'renamed.txt');
    await driver.move('id:file', 'id:dest');
    await driver.copy('id:file', 'id:dest');
    await driver.remove('id:file');

    expect(api.createFolder).toHaveBeenCalledWith('/Projects');
    expect(api.upload).toHaveBeenCalledWith('/notes.txt', expect.any(ReadableStream));
    expect(api.move).toHaveBeenNthCalledWith(1, 'id:file', '/Docs/renamed.txt');
    expect(api.move).toHaveBeenNthCalledWith(2, 'id:file', '/Dest/file.txt');
    expect(api.copy).toHaveBeenCalledWith('id:file', '/Dest/file.txt');
    expect(api.remove).toHaveBeenCalledWith('id:file');
  });

  it('supports explicit exports and ordered resumable uploads', async () => {
    const api = client({
      stat: vi.fn(async (id) => metadata({ id, is_downloadable: false, export_info: { export_as: 'pdf', export_options: ['docx'] } })),
    });
    const driver = new DropboxDriver(mount, api);
    await expect(driver.getDownload('id:file', new Request('https://ilist.example/file')))
      .rejects.toMatchObject({ code: 'DROPBOX_EXPORT_REQUIRED' });
    await driver.getDownload('id:file', new Request('https://ilist.example/file?export=pdf'));
    expect(api.exportFile).toHaveBeenCalledWith('id:file', 'pdf');

    const adapter = driver.resumableUpload!;
    const created = await adapter.create({
      parentId: DROPBOX_ROOT_ID, name: 'video.mp4', size: 12 * 1024 * 1024,
      contentType: 'video/mp4', partSize: 10 * 1024 * 1024,
    });
    const first = await adapter.uploadPart({
      state: created.state, partNumber: 1, offset: 0, totalSize: 12 * 1024 * 1024,
      body: new ReadableStream(), size: 10 * 1024 * 1024, signal: new AbortController().signal,
    });
    const second = await adapter.uploadPart({
      state: first.state!, partNumber: 2, offset: 10 * 1024 * 1024, totalSize: 12 * 1024 * 1024,
      body: new ReadableStream(), size: 2 * 1024 * 1024, signal: new AbortController().signal,
    });
    await expect(adapter.complete({ state: second.state!, parts: [first.part, second.part] }))
      .resolves.toMatchObject({ id: 'id:large', parentId: DROPBOX_ROOT_ID });
    await adapter.abort(second.state!);
    expect(api.appendUploadSession).toHaveBeenNthCalledWith(1, 'private-session', 0, expect.anything(), false, expect.anything());
    expect(api.appendUploadSession).toHaveBeenNthCalledWith(2, 'private-session', 10 * 1024 * 1024, expect.anything(), false, expect.anything());
    expect(api.finishUploadSession).toHaveBeenCalledWith('private-session', 12 * 1024 * 1024, '/video.mp4');
    expect(api.closeUploadSession).toHaveBeenCalledWith('private-session', 12 * 1024 * 1024);
  });

  it('aborts locally when Dropbox cannot close the remote upload session', async () => {
    const api = client({ closeUploadSession: vi.fn(async () => { throw new Error('provider unavailable'); }) });
    const adapter = new DropboxDriver(mount, api).resumableUpload!;
    const created = await adapter.create({
      parentId: DROPBOX_ROOT_ID, name: 'video.mp4', size: 12 * 1024 * 1024,
      contentType: 'video/mp4', partSize: 10 * 1024 * 1024,
    });
    await expect(adapter.abort(created.state)).resolves.toBeUndefined();
  });

  it('rejects items outside a configured Dropbox sub-root and protects the mount root', async () => {
    const scopedMount = { ...mount, rootItemId: 'id:root' };
    const api = client({
      stat: vi.fn(async (id) => {
        if (id === 'id:root') return metadata({ '.tag': 'folder', id, name: 'Scoped', path_lower: '/scoped', path_display: '/Scoped', size: undefined });
        if (id === 'id:inside') return metadata({ id, path_lower: '/scoped/inside.txt', path_display: '/Scoped/inside.txt' });
        return metadata({ id, path_lower: '/outside.txt', path_display: '/outside.txt' });
      }),
    });
    const driver = new DropboxDriver(scopedMount, api);
    await expect(driver.stat('id:inside')).resolves.toMatchObject({ id: 'id:inside' });
    await expect(driver.stat('id:outside')).rejects.toMatchObject({ code: 'STORAGE_ITEM_NOT_FOUND' });
    await expect(driver.rename('id:root', 'renamed')).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
    await expect(driver.remove('id:root')).rejects.toMatchObject({ code: 'INVALID_STORAGE_OPERATION' });
  });
});
