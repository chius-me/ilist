import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveClient, type GoogleFile } from '../../src/worker/drivers/google/client';
import {
  GOOGLE_DOC_MIME_TYPE,
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_SHEET_MIME_TYPE,
  GOOGLE_SLIDE_MIME_TYPE,
  mapGoogleFile,
} from '../../src/worker/drivers/google/items';
import type { Env } from '../../src/worker/types';

const workerEnv = () => env as unknown as Env;

function googleFile(overrides: Partial<GoogleFile> = {}): GoogleFile {
  return {
    id: 'file-1',
    name: '文档.txt',
    mimeType: 'text/plain',
    size: '12',
    modifiedTime: '2026-07-18T01:02:03.000Z',
    md5Checksum: 'md5-1',
    parents: ['parent-1'],
    ...overrides,
  };
}

describe('Google Drive item mapping', () => {
  it('maps ordinary files and folders with stable metadata', () => {
    expect(mapGoogleFile(googleFile(), 'root')).toMatchObject({
      id: 'file-1', parentId: 'parent-1', name: '文档.txt', kind: 'file', size: 12,
      contentType: 'text/plain', modifiedAt: '2026-07-18T01:02:03.000Z', etag: 'md5-1',
    });
    expect(mapGoogleFile(googleFile({ id: 'folder-1', mimeType: GOOGLE_FOLDER_MIME_TYPE, size: undefined, parents: [] }), 'root'))
      .toMatchObject({ id: 'folder-1', parentId: 'root', kind: 'folder', size: null, contentType: null });
  });

  it('exposes explicit export choices for supported Workspace files', () => {
    expect(mapGoogleFile(googleFile({ mimeType: GOOGLE_DOC_MIME_TYPE }), 'root').exportOptions?.map((item) => item.format))
      .toEqual(['pdf', 'docx']);
    expect(mapGoogleFile(googleFile({ mimeType: GOOGLE_SHEET_MIME_TYPE }), 'root').exportOptions?.map((item) => item.format))
      .toEqual(['pdf', 'xlsx']);
    expect(mapGoogleFile(googleFile({ mimeType: GOOGLE_SLIDE_MIME_TYPE }), 'root').exportOptions?.map((item) => item.format))
      .toEqual(['pdf', 'pptx']);
  });
});

describe('Google Drive API client', () => {
  it('lists a parent with a restricted fields projection and opaque page token', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      files: [googleFile()], nextPageToken: 'next-page',
    }));
    const client = new GoogleDriveClient(workerEnv(), 'mount-google', fetcher, async () => 'test-access');

    const result = await client.list("folder'id", 'page one');

    expect(result).toEqual({ items: [googleFile()], nextCursor: 'next-page' });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe('/drive/v3/files');
    expect(url.searchParams.get('q')).toBe("'folder\\'id' in parents and trashed=false");
    expect(url.searchParams.get('pageToken')).toBe('page one');
    expect(url.searchParams.get('spaces')).toBe('drive');
    expect(url.searchParams.get('fields')).toContain('nextPageToken');
    expect(url.searchParams.get('fields')).not.toContain('*');
  });

  it('streams ordinary downloads, forwards one valid Range, and filters response headers', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('partial', {
      status: 206,
      headers: {
        'content-type': 'text/plain', 'content-range': 'bytes 10-16/20',
        'accept-ranges': 'bytes', 'content-length': '7', 'x-private-upstream': 'secret',
      },
    }));
    const client = new GoogleDriveClient(workerEnv(), 'mount-google', fetcher, async () => 'test-access');

    const response = await client.download('item/id', 'bytes=10-16');

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('partial');
    expect(response.headers.get('content-range')).toBe('bytes 10-16/20');
    expect(response.headers.get('x-private-upstream')).toBeNull();
    expect(String(fetcher.mock.calls[0]![0])).toContain('/drive/v3/files/item%2Fid?alt=media');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('range')).toBe('bytes=10-16');
  });

  it('rejects malformed or multi-range download headers before fetching', async () => {
    const fetcher = vi.fn();
    const client = new GoogleDriveClient(workerEnv(), 'mount-google', fetcher, async () => 'test-access');

    await expect(client.download('item', 'bytes=0-1,4-5')).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(client.download('item', 'items=0-1')).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('streams Workspace exports through the files.export endpoint', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('pdf', {
      headers: { 'content-type': 'application/pdf' },
    }));
    const client = new GoogleDriveClient(workerEnv(), 'mount-google', fetcher, async () => 'test-access');

    const response = await client.exportFile('doc/id', 'application/pdf');

    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('pdf');
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe('/drive/v3/files/doc%2Fid/export');
    expect(url.searchParams.get('mimeType')).toBe('application/pdf');
  });

  it('sends folder, rename, move, and trash mutations without permanent deletion', async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (!init.method || init.method === 'GET') return Response.json(googleFile({ parents: ['old-parent'] }));
      return Response.json(googleFile({ id: 'written' }));
    });
    const client = new GoogleDriveClient(workerEnv(), 'mount-google', fetcher, async () => 'test-access');

    await client.createFolder('root', '项目');
    await client.rename('item/id', 'renamed.txt');
    await client.move('item/id', 'destination');
    await client.trash('item/id');

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: '项目', mimeType: GOOGLE_FOLDER_MIME_TYPE, parents: ['root'] });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ name: 'renamed.txt' });
    expect(calls[3]!.url.searchParams.get('addParents')).toBe('destination');
    expect(calls[3]!.url.searchParams.get('removeParents')).toBe('old-parent');
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ trashed: true });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(false);
  });

  it.each([
    [401, 'GOOGLE_AUTH_FAILED', 401],
    [403, 'GOOGLE_ACCESS_DENIED', 403],
    [404, 'STORAGE_ITEM_NOT_FOUND', 404],
    [409, 'STORAGE_CONFLICT', 409],
    [429, 'GOOGLE_RATE_LIMITED', 503],
    [500, 'GOOGLE_UPSTREAM_FAILED', 502],
  ])('normalizes upstream status %i without leaking response bodies', async (upstream, code, status) => {
    const client = new GoogleDriveClient(workerEnv(), 'mount-google', vi.fn(async () => Response.json({
      error: { message: 'private provider response', errors: [{ reason: 'backendError' }] },
    }, { status: upstream })), async () => 'test-access', async () => 'refreshed-access');

    const error = await client.stat('item').catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain('private provider response');
  });
});
