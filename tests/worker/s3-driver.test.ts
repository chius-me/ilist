import { describe, expect, it, vi } from 'vitest';
import { S3Error, type S3ListObjectsResult } from '../../src/worker/drivers/s3/client';
import { S3Driver, type S3DriverClient } from '../../src/worker/drivers/s3/driver';
import { UPLOAD_PART_SIZE_BYTES } from '../../src/worker/drivers/types';
import type { Mount } from '../../src/worker/types';

const mount: Mount = {
  id: 'mount-s3',
  name: 'Archive',
  mountPath: '/archive',
  driverType: 's3',
  provider: 'cloudflare-r2',
  enabled: true,
  isPublic: true,
  sortOrder: 0,
  rootItemId: null,
  config: { rootPrefix: 'tenant/root' },
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
};

function listResult(overrides: Partial<S3ListObjectsResult> = {}): S3ListObjectsResult {
  return { objects: [], commonPrefixes: [], nextContinuationToken: null, isTruncated: false, keyCount: 0, ...overrides };
}

function response(headers: HeadersInit = {}): Response {
  return new Response(null, { status: 200, headers });
}

function client(overrides: Partial<S3DriverClient> = {}): S3DriverClient {
  return {
    listObjectsV2: vi.fn(async () => listResult()),
    headObject: vi.fn(async () => response()),
    getObject: vi.fn(async () => new Response('content')),
    putObject: vi.fn(async () => response({ etag: '"new"' })),
    copyObject: vi.fn(async () => response()),
    deleteObject: vi.fn(async () => response()),
    createMultipartUpload: vi.fn(async () => ({ uploadId: 'upload-123' })),
    uploadPart: vi.fn(async () => ({ etag: '"part-etag"' })),
    completeMultipartUpload: vi.fn(async () => response()),
    abortMultipartUpload: vi.fn(async () => response()),
    ...overrides,
  };
}

describe('S3Driver', () => {
  it('isolates the configured root prefix and preserves pagination', async () => {
    const api = client({
      listObjectsV2: vi.fn(async () => listResult({
        objects: [{ key: 'tenant/root/readme.md', lastModified: '2026-07-15T01:02:03Z', etag: '"e"', size: 7, storageClass: null }],
        commonPrefixes: ['tenant/root/photos/'],
        nextContinuationToken: 'opaque cursor',
        isTruncated: true,
        keyCount: 2,
      })),
    });
    const driver = new S3Driver(mount, api);

    const result = await driver.list(driver.rootId, 'opaque input');

    expect(api.listObjectsV2).toHaveBeenCalledWith({ prefix: 'tenant/root/', delimiter: '/', continuationToken: 'opaque input' });
    expect(result.nextCursor).toBe('opaque cursor');
    expect(result.items.map((item) => [item.name, item.kind])).toEqual([['photos', 'folder'], ['readme.md', 'file']]);
    expect(() => driver.decodeItemId(result.items[0]!.id).key.startsWith('tenant/root/')).not.toThrow();
  });

  it('creates explicit empty folders and streams uploads without reading the body', async () => {
    const api = client();
    const driver = new S3Driver(mount, api);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });

    const folder = await driver.createFolder(driver.rootId, 'Empty');
    const file = await driver.upload(folder.id, 'video.bin', body, 'application/octet-stream');

    expect(api.putObject).toHaveBeenNthCalledWith(1, 'tenant/root/Empty/', expect.any(ReadableStream), { contentType: 'application/x-directory' });
    expect(api.putObject).toHaveBeenNthCalledWith(2, 'tenant/root/Empty/video.bin', body, { contentType: 'application/octet-stream' });
    expect(file.name).toBe('video.bin');
  });

  it('forwards Range downloads and returns the original stream response', async () => {
    const upstream = new Response('partial', { status: 206, headers: { 'content-range': 'bytes 0-6/10' } });
    const api = client({ getObject: vi.fn(async () => upstream) });
    const driver = new S3Driver(mount, api);
    const item = driver.itemId('tenant/root/file.txt', 'file');

    const result = await driver.getDownload(item, new Request('https://ilist.test/file', { headers: { range: 'bytes=0-6' } }));

    expect(api.getObject).toHaveBeenCalledWith('tenant/root/file.txt', { range: 'bytes=0-6' });
    expect(result).toEqual({ kind: 'stream', response: upstream });
  });

  it('uses object metadata instead of downloading the body for HEAD requests', async () => {
    const api = client({ headObject: vi.fn(async () => response({ 'content-length': '7' })) });
    const driver = new S3Driver(mount, api);
    const item = driver.itemId('tenant/root/file.txt', 'file');

    const result = await driver.getDownload(item, new Request('https://ilist.test/file', { method: 'HEAD' }));

    expect(api.headObject).toHaveBeenCalledWith('tenant/root/file.txt');
    expect(api.getObject).not.toHaveBeenCalled();
    expect(result.kind).toBe('stream');
    if (result.kind === 'stream') expect(result.response.headers.get('content-length')).toBe('7');
  });

  it('renames a file by copying before deleting the source', async () => {
    const order: string[] = [];
    const api = client({
      copyObject: vi.fn(async (source, destination) => { order.push(`copy:${source}:${destination}`); return response(); }),
      deleteObject: vi.fn(async (key) => { order.push(`delete:${key}`); return response(); }),
    });
    const driver = new S3Driver(mount, api);

    const renamed = await driver.rename(driver.itemId('tenant/root/old.txt', 'file'), 'new.txt');

    expect(order).toEqual(['copy:tenant/root/old.txt:tenant/root/new.txt', 'delete:tenant/root/old.txt']);
    expect(renamed.name).toBe('new.txt');
  });

  it('does not delete a source when a move copy fails', async () => {
    const api = client({ copyObject: vi.fn(async () => { throw new S3Error(500, 'InternalError', 'copy failed'); }) });
    const driver = new S3Driver(mount, api);
    const source = driver.itemId('tenant/root/file.txt', 'file');
    const destination = driver.itemId('tenant/root/destination/', 'folder');

    await expect(driver.move(source, destination)).rejects.toThrow('copy failed');
    expect(api.deleteObject).not.toHaveBeenCalled();
  });

  it('rejects no-op rename and move operations before copying', async () => {
    const api = client();
    const driver = new S3Driver(mount, api);
    const source = driver.itemId('tenant/root/file.txt', 'file');

    await expect(driver.rename(source, 'file.txt')).rejects.toMatchObject({ code: 'INVALID_STORAGE_DESTINATION' });
    await expect(driver.move(source, driver.rootId)).rejects.toMatchObject({ code: 'INVALID_STORAGE_DESTINATION' });
    expect(api.copyObject).not.toHaveBeenCalled();
    expect(api.deleteObject).not.toHaveBeenCalled();
  });

  it('preserves every folder source when a later recursive copy fails', async () => {
    const api = client({
      listObjectsV2: vi.fn(async () => listResult({ objects: [
        { key: 'tenant/root/source/a.txt', lastModified: null, etag: null, size: 1, storageClass: null },
        { key: 'tenant/root/source/b.txt', lastModified: null, etag: null, size: 1, storageClass: null },
      ] })),
      copyObject: vi.fn()
        .mockResolvedValueOnce(response())
        .mockRejectedValueOnce(new S3Error(500, 'InternalError', 'second copy failed')),
    });
    const driver = new S3Driver(mount, api);

    await expect(driver.move(
      driver.itemId('tenant/root/source/', 'folder'),
      driver.itemId('tenant/root/destination/', 'folder'),
    )).rejects.toThrow('second copy failed');
    expect(api.deleteObject).not.toHaveBeenCalled();
  });

  it('moves folders recursively and deletes sources only after every copy succeeds', async () => {
    const order: string[] = [];
    const api = client({
      listObjectsV2: vi.fn(async () => listResult({ objects: [
        { key: 'tenant/root/source/', lastModified: null, etag: null, size: 0, storageClass: null },
        { key: 'tenant/root/source/a.txt', lastModified: null, etag: null, size: 1, storageClass: null },
      ] })),
      copyObject: vi.fn(async (source, destination) => { order.push(`copy:${source}:${destination}`); return response(); }),
      deleteObject: vi.fn(async (key) => { order.push(`delete:${key}`); return response(); }),
    });
    const driver = new S3Driver(mount, api);

    await driver.move(driver.itemId('tenant/root/source/', 'folder'), driver.itemId('tenant/root/dest/', 'folder'));

    expect(order).toEqual([
      'copy:tenant/root/source/:tenant/root/dest/source/',
      'copy:tenant/root/source/a.txt:tenant/root/dest/source/a.txt',
      'delete:tenant/root/source/a.txt',
      'delete:tenant/root/source/',
    ]);
  });

  it('deletes folders recursively across list pages', async () => {
    const api = client({
      listObjectsV2: vi.fn()
        .mockResolvedValueOnce(listResult({ objects: [{ key: 'tenant/root/f/a', lastModified: null, etag: null, size: 1, storageClass: null }], nextContinuationToken: 'next', isTruncated: true }))
        .mockResolvedValueOnce(listResult({ objects: [{ key: 'tenant/root/f/b', lastModified: null, etag: null, size: 1, storageClass: null }] })),
    });
    const driver = new S3Driver(mount, api);

    await driver.remove(driver.itemId('tenant/root/f/', 'folder'));

    expect(api.deleteObject).toHaveBeenCalledWith('tenant/root/f/a');
    expect(api.deleteObject).toHaveBeenCalledWith('tenant/root/f/b');
  });

  it('rejects malformed IDs, unsafe names, and IDs from another mount', async () => {
    const driver = new S3Driver(mount, client());
    const other = new S3Driver({ ...mount, id: 'other' }, client());

    expect(() => driver.decodeItemId('invalid')).toThrow();
    expect(() => driver.decodeItemId(other.itemId('tenant/root/file', 'file'))).toThrow();
    await expect(driver.createFolder(driver.rootId, '../escape')).rejects.toThrow();
    await expect(driver.upload(driver.rootId, 'nested/file', new ReadableStream(), null)).rejects.toThrow();
  });

  it('creates a root-scoped S3 multipart session and completes ordered parts with final metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:05:06.000Z'));
    try {
      const api = client({
        headObject: vi.fn(async () => response({
          'content-length': String(20 * 1024 * 1024),
          'content-type': 'application/octet-stream',
          'last-modified': 'Thu, 17 Jul 2026 04:05:10 GMT',
          etag: '"complete-etag"',
        })),
      });
      const driver = new S3Driver(mount, api);
      const adapter = driver.resumableUpload!;
      const session = await adapter.create({
        parentId: driver.rootId,
        name: 'archive.bin',
        size: 20 * 1024 * 1024,
        contentType: 'application/octet-stream',
        partSize: UPLOAD_PART_SIZE_BYTES,
      });
      const body = new ReadableStream();
      const controller = new AbortController();

      expect(session).toMatchObject({
        state: {
          key: 'tenant/root/archive.bin',
          uploadId: 'upload-123',
          parentId: driver.rootId,
          contentType: 'application/octet-stream',
        },
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      expect(api.createMultipartUpload).toHaveBeenCalledWith('tenant/root/archive.bin', 'application/octet-stream');

      await expect(adapter.uploadPart({
        state: session.state,
        partNumber: 1,
        offset: 0,
        totalSize: 20 * 1024 * 1024,
        body,
        size: UPLOAD_PART_SIZE_BYTES,
        signal: controller.signal,
      })).resolves.toEqual({ part: { partNumber: 1, size: UPLOAD_PART_SIZE_BYTES, etag: '"part-etag"' } });
      expect(api.uploadPart).toHaveBeenCalledWith('tenant/root/archive.bin', 'upload-123', 1, body, { signal: controller.signal });

      const completed = await adapter.complete({
        state: session.state,
        parts: [
          { partNumber: 2, size: UPLOAD_PART_SIZE_BYTES, etag: '"part-2"' },
          { partNumber: 1, size: UPLOAD_PART_SIZE_BYTES, etag: '"part-1"' },
        ],
      });

      expect(api.completeMultipartUpload).toHaveBeenCalledWith('tenant/root/archive.bin', 'upload-123', [
        { partNumber: 1, size: UPLOAD_PART_SIZE_BYTES, etag: '"part-1"' },
        { partNumber: 2, size: UPLOAD_PART_SIZE_BYTES, etag: '"part-2"' },
      ]);
      expect(api.headObject).toHaveBeenCalledWith('tenant/root/archive.bin');
      expect(completed).toMatchObject({
        parentId: driver.rootId,
        name: 'archive.bin',
        kind: 'file',
        size: 20 * 1024 * 1024,
        contentType: 'application/octet-stream',
        modifiedAt: 'Thu, 17 Jul 2026 04:05:10 GMT',
        etag: '"complete-etag"',
      });

      await adapter.abort(session.state);
      expect(api.abortMultipartUpload).toHaveBeenCalledWith('tenant/root/archive.bin', 'upload-123');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid multipart target names and serialized provider state', async () => {
    const api = client();
    const driver = new S3Driver(mount, api);
    const adapter = driver.resumableUpload!;
    const invalidState = {
      key: 'tenant/root/archive.bin',
      uploadId: 'upload-123',
      parentId: driver.rootId,
      contentType: 42,
    };

    await expect(adapter.create({
      parentId: driver.rootId,
      name: '../archive.bin',
      size: 20 * 1024 * 1024,
      contentType: 'application/octet-stream',
      partSize: UPLOAD_PART_SIZE_BYTES,
    })).rejects.toMatchObject({ code: 'INVALID_ENTRY_NAME' });
    await expect(adapter.uploadPart({
      state: invalidState,
      partNumber: 1,
      offset: 0,
      totalSize: UPLOAD_PART_SIZE_BYTES,
      body: new ReadableStream(),
      size: UPLOAD_PART_SIZE_BYTES,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_UPLOAD_STATE' });
    expect(api.createMultipartUpload).not.toHaveBeenCalled();
    expect(api.uploadPart).not.toHaveBeenCalled();
  });
});
