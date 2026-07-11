import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getEntryById } from '../../src/worker/db';
import { createFolder, deleteEntryTrees, uploadFile } from '../../src/worker/file-system';
import { streamEntryObject } from '../../src/worker/r2';
import type { Env } from '../../src/worker/types';

const workerEnv = env as unknown as Env;

describe('R2 file lifecycle', () => {
  it('uploads a streamed body and marks the entry ready', async () => {
    const request = new Request('https://ilist.example/api/admin/files/file-12345678', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello range',
    });
    const entry = await uploadFile(workerEnv, request, {
      id: 'file-12345678', parentId: 'root', name: 'hello.txt',
    });

    expect(entry).toMatchObject({ id: 'file-12345678', name: 'hello.txt', size: 11 });
    expect(await getEntryById(workerEnv.DB, entry.id)).toMatchObject({
      status: 'ready', storage_key: 'blobs/file-12345678',
    });
  });

  it('serves a stable ID with Range and attachment headers', async () => {
    const upload = new Request('https://ilist.example/upload', { method: 'PUT', body: 'hello range' });
    const entry = await uploadFile(workerEnv, upload, {
      id: 'file-abcdefgh', parentId: 'root', name: 'hello.txt',
    });
    const row = (await getEntryById(workerEnv.DB, entry.id))!;
    const response = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file', {
      headers: { range: 'bytes=0-4' },
    }), { download: true, publicFile: true });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    await expect(response.text()).resolves.toBe('hello');
  });

  it('recursively deletes a folder and its blobs', async () => {
    const folder = await createFolder(workerEnv.DB, { parentId: 'root', name: 'Folder' });
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id: 'file-delete123', parentId: folder.id, name: 'x.txt',
    });

    const result = await deleteEntryTrees(workerEnv, [folder.id]);

    expect(result).toEqual({ succeeded: [folder.id], failed: [] });
    expect(await getEntryById(workerEnv.DB, folder.id)).toBeNull();
    expect(await workerEnv.R2_BUCKET.get('blobs/file-delete123')).toBeNull();
  });

  it('restores a failed file and its folder while deleting successful siblings', async () => {
    const folder = await createFolder(workerEnv.DB, { parentId: 'root', name: 'Partial failure' });
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'first' }), {
      id: 'file-success123', parentId: folder.id, name: 'first.txt',
    });
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'second' }), {
      id: 'file-failure123', parentId: folder.id, name: 'second.txt',
    });

    const result = await deleteEntryTrees(workerEnv, [folder.id], {
      deleteBlob: async (key) => {
        if (key === 'blobs/file-failure123') throw new Error('R2 unavailable');
        await workerEnv.R2_BUCKET.delete(key);
      },
    });

    expect(result).toMatchObject({
      succeeded: [],
      failed: [{ id: folder.id, code: 'STORAGE_OPERATION_FAILED' }],
    });
    expect(await getEntryById(workerEnv.DB, 'file-success123')).toBeNull();
    expect(await getEntryById(workerEnv.DB, 'file-failure123')).toMatchObject({ status: 'ready' });
    expect(await getEntryById(workerEnv.DB, folder.id)).toMatchObject({ status: 'ready' });
  });
});
