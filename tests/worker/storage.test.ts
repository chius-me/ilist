import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEntryByStorageKey, getEntryById } from '../../src/worker/db';
import { createFolder, deleteEntryTrees, uploadFile } from '../../src/worker/file-system';
import { streamEntryObject } from '../../src/worker/r2';
import type { Env } from '../../src/worker/types';

const workerEnv = env as unknown as Env;

let fixture = '';
let fixtureIds: string[] = [];
let fixtureKeys: string[] = [];

function fileId(label: string): string {
  return `storage-${fixture}-${label}`;
}

async function upload(label: string, body: string, name = `${label}.txt`) {
  const id = fileId(label);
  fixtureIds.push(id);
  fixtureKeys.push(`blobs/${id}`);
  return await uploadFile(workerEnv, new Request('https://ilist.example/upload', {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body,
  }), { id, parentId: 'root', name: `${fixture}-${name}` });
}

async function folder(label: string) {
  const entry = await createFolder(workerEnv.DB, { parentId: 'root', name: `${fixture}-${label}` });
  fixtureIds.push(entry.id);
  return entry;
}

function bucketWith(overrides: Record<string, unknown>): R2Bucket {
  return new Proxy(workerEnv.R2_BUCKET, {
    get(target, property) {
      if (property in overrides) return overrides[property as string];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as R2Bucket;
}

beforeEach(() => {
  fixture = crypto.randomUUID().replaceAll('-', '');
  fixtureIds = [];
  fixtureKeys = [];
});

afterEach(async () => {
  if (fixtureKeys.length) await workerEnv.R2_BUCKET.delete([...new Set(fixtureKeys)]);
  for (const id of fixtureIds.reverse()) {
    await workerEnv.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  }
});

describe('R2 file lifecycle', () => {
  it('uploads a streamed body, finalizes it, and finds it by storage key', async () => {
    const entry = await upload('ready', 'hello range');

    expect(entry).toMatchObject({ id: fileId('ready'), size: 11 });
    expect(await getEntryById(workerEnv.DB, entry.id)).toMatchObject({
      status: 'ready', storage_key: `blobs/${entry.id}`,
    });
    expect(await findEntryByStorageKey(workerEnv.DB, `blobs/${entry.id}`)).toMatchObject({ id: entry.id });
  });

  it('sets full and ranged GET and HEAD response lengths from the R2 object', async () => {
    const entry = await upload('ranges', 'hello range');
    const row = (await getEntryById(workerEnv.DB, entry.id))!;

    const full = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file'), {
      download: true, publicFile: true,
    });
    const head = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file', { method: 'HEAD' }), {
      download: true, publicFile: true,
    });
    const range = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file', {
      headers: { range: 'bytes=0-4' },
    }), { download: true, publicFile: true });
    const rangeHead = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file', {
      method: 'HEAD', headers: { range: 'bytes=6-' },
    }), { download: true, publicFile: true });

    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('11');
    await expect(full.text()).resolves.toBe('hello range');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('11');
    await expect(head.text()).resolves.toBe('');
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 0-4/11');
    expect(range.headers.get('content-length')).toBe('5');
    await expect(range.text()).resolves.toBe('hello');
    expect(rangeHead.status).toBe(206);
    expect(rangeHead.headers.get('content-range')).toBe('bytes 6-10/11');
    expect(rangeHead.headers.get('content-length')).toBe('5');
    await expect(rangeHead.text()).resolves.toBe('');
  });

  it('returns 304 only for GET or HEAD cache matches and 412 for failed preconditions', async () => {
    const entry = await upload('conditions', 'hello range');
    const row = (await getEntryById(workerEnv.DB, entry.id))!;
    const etag = row.etag!;
    const uploaded = (await workerEnv.R2_BUCKET.head(row.storage_key!))!.uploaded.toUTCString();
    const request = (method: string, headers: HeadersInit) => new Request('https://ilist.example/file', { method, headers });

    const getMatch = await streamEntryObject(workerEnv.R2_BUCKET, row, request('GET', { 'if-none-match': etag }), {
      download: false, publicFile: true,
    });
    const headMatch = await streamEntryObject(workerEnv.R2_BUCKET, row, request('HEAD', { 'if-none-match': etag }), {
      download: false, publicFile: true,
    });
    const unsafeMatch = await streamEntryObject(workerEnv.R2_BUCKET, row, request('PUT', { 'if-none-match': etag }), {
      download: false, publicFile: true,
    });
    const ifMatchFailure = await streamEntryObject(workerEnv.R2_BUCKET, row, request('GET', { 'if-match': '"different"' }), {
      download: false, publicFile: true,
    });
    const stale = await streamEntryObject(workerEnv.R2_BUCKET, row, request('GET', {
      'if-unmodified-since': 'Wed, 01 Jan 2020 00:00:00 GMT',
    }), { download: false, publicFile: true });
    const current = await streamEntryObject(workerEnv.R2_BUCKET, row, request('GET', {
      'if-unmodified-since': uploaded,
    }), { download: false, publicFile: true });

    expect(getMatch.status).toBe(304);
    expect(headMatch.status).toBe(304);
    expect(unsafeMatch.status).toBe(412);
    expect(ifMatchFailure.status).toBe(412);
    expect(stale.status).toBe(412);
    expect(current.status).toBe(200);
  });

  it('returns 416 with the object size for malformed and unsatisfiable ranges', async () => {
    const entry = await upload('invalid-range', 'hello range');
    const row = (await getEntryById(workerEnv.DB, entry.id))!;

    for (const range of ['bytes=wat', 'bytes=99-', 'bytes=5-4']) {
      const response = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file', {
        headers: { range },
      }), { download: false, publicFile: true });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */11');
    }
  });

  it('encodes attachment filenames as strict RFC 8187 ext-values', async () => {
    const entry = await upload('filename', 'x', "d'oh (draft)*-资料.txt");
    const row = (await getEntryById(workerEnv.DB, entry.id))!;
    const response = await streamEntryObject(workerEnv.R2_BUCKET, row, new Request('https://ilist.example/file'), {
      download: true, publicFile: true,
    });

    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${fixture}-d%27oh%20%28draft%29%2A-%E8%B5%84%E6%96%99.txt`,
    );
  });

  it('rejects a concurrent same-ID retry and only the owning failed upload compensates', async () => {
    const id = fileId('overlap');
    const key = `blobs/${id}`;
    fixtureIds.push(id);
    fixtureKeys.push(key);
    let startPut!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((resolve) => { startPut = resolve; });
    const release = new Promise<void>((resolve) => { releasePut = resolve; });
    const failingEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        put: async (...args: Parameters<R2Bucket['put']>) => {
          await workerEnv.R2_BUCKET.put(...args);
          startPut();
          await release;
          throw new Error('finalize failed');
        },
      }),
    };
    const input = { id, parentId: 'root', name: `${fixture}-overlap.txt` };
    const owner = uploadFile(failingEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'owner' }), input);

    await putStarted;
    await expect(uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'retry' }), input)).rejects.toMatchObject({
      status: 409, code: 'UPLOAD_IN_PROGRESS',
    });
    releasePut();
    await expect(owner).rejects.toMatchObject({ status: 502, code: 'STORAGE_OPERATION_FAILED' });
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
    expect(await workerEnv.R2_BUCKET.get(key)).toBeNull();
  });

  it('recursively deletes a folder and its blobs', async () => {
    const parent = await folder('delete');
    const id = fileId('delete');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: parent.id, name: `${fixture}-x.txt`,
    });

    const result = await deleteEntryTrees(workerEnv, [parent.id]);

    expect(result).toEqual({ succeeded: [parent.id], failed: [] });
    expect(await getEntryById(workerEnv.DB, parent.id)).toBeNull();
    expect(await workerEnv.R2_BUCKET.get(`blobs/${id}`)).toBeNull();
  });

  it('restores a failed file and its folder while deleting successful siblings', async () => {
    const parent = await folder('partial');
    const successId = fileId('success');
    const failureId = fileId('failure');
    fixtureIds.push(successId, failureId);
    fixtureKeys.push(`blobs/${successId}`, `blobs/${failureId}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'first' }), {
      id: successId, parentId: parent.id, name: `${fixture}-first.txt`,
    });
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'second' }), {
      id: failureId, parentId: parent.id, name: `${fixture}-second.txt`,
    });

    const result = await deleteEntryTrees(workerEnv, [parent.id], {
      deleteBlob: async (key) => {
        if (key === `blobs/${failureId}`) throw new Error('R2 unavailable');
        await workerEnv.R2_BUCKET.delete(key);
      },
    });

    expect(result).toMatchObject({
      succeeded: [],
      failed: [{ id: parent.id, code: 'STORAGE_OPERATION_FAILED' }],
    });
    expect(await getEntryById(workerEnv.DB, successId)).toBeNull();
    expect(await getEntryById(workerEnv.DB, failureId)).toMatchObject({ status: 'ready' });
    expect(await getEntryById(workerEnv.DB, parent.id)).toMatchObject({ status: 'ready' });
  });
});
