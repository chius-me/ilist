import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateStorageRecoveryOperation,
  enqueueStorageRecoveryOperation,
  findEntryByStorageKey,
  getEntryById,
  listStorageRecoveryOperations,
  touchHeldStorageRecoveryOperation,
} from '../../src/worker/db';
import {
  createFolder,
  deleteEntryTrees,
  moveEntries,
  patchEntry,
  reconcileStorageRecovery,
  uploadFile,
} from '../../src/worker/file-system';
import { streamEntryObject } from '../../src/worker/r2';
import type { Entry, Env } from '../../src/worker/types';

const workerEnv = env as unknown as Env;

let fixture = '';
let fixtureIds: string[] = [];
let fixtureKeys: string[] = [];

function fileId(label: string): string {
  return `storage-${fixture}-${label}`;
}

function expectSecureFileHeaders(response: Response): void {
  expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
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

function dbWithFailure(shouldFail: (sql: string) => boolean): D1Database {
  let failed = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(statementTarget, statementProperty) {
      if (statementProperty === 'bind') return (...values: unknown[]) => wrap(statementTarget.bind(...values), sql);
      if (statementProperty === 'run') {
        return async <T>() => {
          if (!failed && shouldFail(sql)) {
            failed = true;
            throw new Error('injected D1 failure');
          }
          return await statementTarget.run<T>();
        };
      }
      const value = Reflect.get(statementTarget, statementProperty, statementTarget);
      return typeof value === 'function' ? value.bind(statementTarget) : value;
    },
  }) as D1PreparedStatement;
  return new Proxy(workerEnv.DB, {
    get(target, property) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string) => {
        return wrap(target.prepare(sql), sql.replace(/\s+/g, ' ').trim());
      };
    },
  }) as D1Database;
}

function pausedEntryInsert() {
  let signalInsert!: () => void;
  let releaseInsert!: () => void;
  const insertReached = new Promise<void>((resolve) => { signalInsert = resolve; });
  const release = new Promise<void>((resolve) => { releaseInsert = resolve; });
  let paused = false;

  const delayedStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => delayedStatement(target.bind(...values));
      if (property === 'run') {
        return async <T>() => {
          if (!paused) {
            paused = true;
            signalInsert();
            await release;
          }
          return await target.run<T>();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1PreparedStatement;

  const db = new Proxy(workerEnv.DB, {
    get(target, property) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        return sql.includes('INSERT INTO entries') ? delayedStatement(statement) : statement;
      };
    },
  }) as D1Database;

  return { db, insertReached, release: releaseInsert };
}

function deletionGate() {
  let startDelete!: () => void;
  let releaseDelete!: () => void;
  const deleteStarted = new Promise<void>((resolve) => { startDelete = resolve; });
  const release = new Promise<void>((resolve) => { releaseDelete = resolve; });
  return {
    deleteStarted,
    release: releaseDelete,
    deleteBlob: async (key: string) => {
      startDelete();
      await release;
      await workerEnv.R2_BUCKET.delete(key);
    },
  };
}

beforeEach(() => {
  fixture = crypto.randomUUID().replaceAll('-', '');
  fixtureIds = [];
  fixtureKeys = [];
});

afterEach(async () => {
  for (const id of fixtureIds) {
    const entry = await getEntryById(workerEnv.DB, id);
    if (entry?.storage_key) fixtureKeys.push(entry.storage_key);
    for (const operation of await listStorageRecoveryOperations(workerEnv.DB, id)) {
      if (operation.storage_key) fixtureKeys.push(operation.storage_key);
    }
  }
  if (fixtureKeys.length) await workerEnv.R2_BUCKET.delete([...new Set(fixtureKeys)]);
  for (const id of fixtureIds) {
    await workerEnv.DB.prepare('DELETE FROM storage_recovery_operations WHERE entry_id = ?').bind(id).run();
  }
  for (const id of fixtureIds.reverse()) {
    await workerEnv.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  }
});

describe('R2 file lifecycle', () => {
  it('uploads a streamed body, finalizes it, and finds it by storage key', async () => {
    const entry = await upload('ready', 'hello range');
    const row = (await getEntryById(workerEnv.DB, entry.id))!;

    expect(entry).toMatchObject({ id: fileId('ready'), size: 11 });
    expect(row).toMatchObject({ status: 'ready' });
    expect(row.storage_key).toMatch(new RegExp(`^blobs/${entry.id}/`));
    expect(await findEntryByStorageKey(workerEnv.DB, row.storage_key!)).toMatchObject({ id: entry.id });
  });

  it('passes the request stream directly to R2 without buffering it', async () => {
    const id = fileId('stream');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    let received: ReadableStream | null = null;
    const streamingEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        put: async (key: string, value: ReadableStream, options?: R2PutOptions) => {
          received = value;
          return await workerEnv.R2_BUCKET.put(key, value, options);
        },
      }),
    };

    const request = new Request('https://ilist.example/upload', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'streamed body',
    });
    const requestBody = request.body!;
    await uploadFile(streamingEnv, request, {
      id, parentId: 'root', name: `${fixture}-stream.txt`,
    });

    expect(received).toBe(requestBody);
  });

  it('touches a held upload recovery operation only for its matching attempt', async () => {
    const id = fileId('held-touch');
    fixtureIds.push(id);
    const operationId = `upload:${id}:attempt-owner`;
    await enqueueStorageRecoveryOperation(workerEnv.DB, {
      id: operationId,
      entryId: id,
      operationKind: 'upload_cleanup',
      storageKey: `blobs/${id}`,
      attemptOwner: 'attempt-owner',
      phase: 'uploading',
      state: 'held',
    });
    const before = (await listStorageRecoveryOperations(workerEnv.DB, id))[0]!;
    const touchedAt = Date.parse(before.updated_at) + 60_000;

    await expect(touchHeldStorageRecoveryOperation(workerEnv.DB, operationId, 'other-attempt', touchedAt)).resolves.toBe(false);
    expect((await listStorageRecoveryOperations(workerEnv.DB, id))[0]!.updated_at).toBe(before.updated_at);
    await expect(touchHeldStorageRecoveryOperation(workerEnv.DB, operationId, 'attempt-owner', touchedAt)).resolves.toBe(true);
    expect((await listStorageRecoveryOperations(workerEnv.DB, id))[0]!.updated_at).toBe(new Date(touchedAt).toISOString());
  });

  it('heartbeats a held upload through a stalled R2 PUT so recovery cannot claim it', async () => {
    const id = fileId('upload-heartbeat');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    let startPut!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((resolve) => { startPut = resolve; });
    const release = new Promise<void>((resolve) => { releasePut = resolve; });
    let heartbeat!: () => void;
    let cleared = 0;
    let now = Date.now();
    const heartbeatEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        put: async (...args: Parameters<R2Bucket['put']>) => {
          startPut();
          await release;
          return await workerEnv.R2_BUCKET.put(...args);
        },
      }),
    };

    const uploadAttempt = uploadFile(heartbeatEnv, new Request('https://ilist.example/upload', {
      method: 'PUT', body: 'streamed body',
    }), { id, parentId: 'root', name: `${fixture}-heartbeat.txt` }, {
      recoveryHeartbeat: {
        now: () => now,
        heartbeatIntervalMs: 60_000,
        setInterval: (callback) => {
          heartbeat = callback;
          return 'heartbeat-timer';
        },
        clearInterval: (interval) => {
          expect(interval).toBe('heartbeat-timer');
          cleared += 1;
        },
      },
    });

    await putStarted;
    const held = (await listStorageRecoveryOperations(workerEnv.DB, id))[0]!;
    now = Date.parse(held.updated_at) + 4 * 60_000;
    await heartbeat();
    now += 4 * 60_000;
    await heartbeat();

    await expect(reconcileStorageRecovery(workerEnv, { now: () => now })).resolves.toEqual({
      processed: 0, completed: 0, retried: 0,
    });
    expect((await listStorageRecoveryOperations(workerEnv.DB, id))[0]).toMatchObject({
      state: 'held', updated_at: new Date(now).toISOString(),
    });

    releasePut();
    await expect(uploadAttempt).resolves.toMatchObject({ id });
    expect(cleared).toBe(1);
    await heartbeat();
    expect(cleared).toBe(1);
  });

  it('stops a held upload heartbeat when R2 PUT fails', async () => {
    const id = fileId('heartbeat-put-failure');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    let heartbeat!: () => void;
    let cleared = 0;
    const failingEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({ put: async () => { throw new Error('R2 PUT failed'); } }),
    };

    await expect(uploadFile(failingEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: 'root', name: `${fixture}-heartbeat-failure.txt`,
    }, {
      recoveryHeartbeat: {
        setInterval: (callback) => {
          heartbeat = callback;
          return 'heartbeat-timer';
        },
        clearInterval: () => { cleared += 1; },
      },
    })).rejects.toMatchObject({ status: 502, code: 'STORAGE_OPERATION_FAILED' });

    expect(cleared).toBe(1);
    await heartbeat();
    expect(cleared).toBe(1);
  });

  it('reclaims a stale held upload recovery operation with no heartbeat', async () => {
    const id = fileId('stale-held-upload');
    const key = `blobs/${id}`;
    fixtureIds.push(id);
    fixtureKeys.push(key);
    const owner = 'crashed-upload-owner';
    const operationId = `upload:${id}:${owner}`;
    const staleAt = Date.now() - 6 * 60_000;
    const timestamp = new Date(staleAt).toISOString();
    await workerEnv.DB.prepare(`INSERT INTO entries (
      id, parent_id, name, kind, storage_key, size, content_type, etag, status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
    ) VALUES (?, 'root', ?, 'file', ?, 0, NULL, NULL, 'uploading', ?, 1, 0, '', ?, ?)`).bind(
      id, `${fixture}-stale.txt`, key, owner, timestamp, timestamp,
    ).run();
    await enqueueStorageRecoveryOperation(workerEnv.DB, {
      id: operationId,
      entryId: id,
      operationKind: 'upload_cleanup',
      storageKey: key,
      attemptOwner: owner,
      phase: 'uploading',
      state: 'held',
    });
    await workerEnv.DB.prepare('UPDATE storage_recovery_operations SET updated_at = ? WHERE id = ?')
      .bind(timestamp, operationId).run();
    await workerEnv.R2_BUCKET.put(key, 'orphaned body');

    await expect(reconcileStorageRecovery(workerEnv, { now: () => Date.now() })).resolves.toEqual({
      processed: 1, completed: 1, retried: 0,
    });
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
    expect(await workerEnv.R2_BUCKET.get(key)).toBeNull();
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

  it('uses a range only when If-Range matches its ETag or date', async () => {
    const entry = await upload('if-range', 'hello range');
    const row = (await getEntryById(workerEnv.DB, entry.id))!;
    const uploaded = (await workerEnv.R2_BUCKET.head(row.storage_key!))!.uploaded.toUTCString();
    const response = async (method: string, ifRange: string) => await streamEntryObject(
      workerEnv.R2_BUCKET,
      row,
      new Request('https://ilist.example/file', { method, headers: { range: 'bytes=0-4', 'if-range': ifRange } }),
      { download: false, publicFile: true },
    );

    const matchingEtag = await response('GET', row.etag!);
    const staleEtag = await response('HEAD', '"stale"');
    const matchingDate = await response('HEAD', uploaded);
    const staleDate = await response('GET', 'Wed, 01 Jan 2020 00:00:00 GMT');

    expect(matchingEtag.status).toBe(206);
    await expect(matchingEtag.text()).resolves.toBe('hello');
    expect(staleEtag.status).toBe(200);
    expect(staleEtag.headers.get('content-length')).toBe('11');
    expect(staleEtag.headers.get('content-range')).toBeNull();
    expect(matchingDate.status).toBe(206);
    expect(matchingDate.headers.get('content-length')).toBe('5');
    expect(staleDate.status).toBe(200);
    await expect(staleDate.text()).resolves.toBe('hello range');
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
    expectSecureFileHeaders(ifMatchFailure);
    expect(ifMatchFailure.headers.get('content-type')).toBe('application/octet-stream');
    expect(ifMatchFailure.headers.get('content-disposition')).toMatch(/^attachment;/);
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
      expectSecureFileHeaders(response);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
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

  it('rejects a folder creation that read its parent before deletion claimed the tree', async () => {
    const parent = await folder('create-race');
    const existing = fileId('create-race-existing');
    fixtureIds.push(existing);
    fixtureKeys.push(`blobs/${existing}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'existing' }), {
      id: existing, parentId: parent.id, name: `${fixture}-existing.txt`,
    });
    const delayed = pausedEntryInsert();
    const gate = deletionGate();
    const creation = createFolder(delayed.db, { parentId: parent.id, name: `${fixture}-late-folder` });

    await delayed.insertReached;
    const deletion = deleteEntryTrees(workerEnv, [parent.id], { deleteBlob: gate.deleteBlob });
    await gate.deleteStarted;
    delayed.release();
    const creationResult: Entry | Error = await creation.then(
      (entry) => entry,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    if (!(creationResult instanceof Error)) fixtureIds.push(creationResult.id);
    gate.release();
    const deletionResult = await deletion;

    expect(creationResult).toMatchObject({ status: 404, code: 'ENTRY_NOT_FOUND' });
    expect(deletionResult).toEqual({ succeeded: [parent.id], failed: [] });
    expect(await getEntryById(workerEnv.DB, parent.id)).toBeNull();
  });

  it('rejects an upload that read its parent before deletion claimed the tree', async () => {
    const parent = await folder('upload-race');
    const existing = fileId('upload-race-existing');
    const late = fileId('upload-race-late');
    fixtureIds.push(existing, late);
    fixtureKeys.push(`blobs/${existing}`, `blobs/${late}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'existing' }), {
      id: existing, parentId: parent.id, name: `${fixture}-existing.txt`,
    });
    const delayed = pausedEntryInsert();
    const gate = deletionGate();
    const uploadAttempt = uploadFile({ ...workerEnv, DB: delayed.db }, new Request('https://ilist.example/upload', {
      method: 'PUT', body: 'late',
    }), { id: late, parentId: parent.id, name: `${fixture}-late.txt` });

    await delayed.insertReached;
    const deletion = deleteEntryTrees(workerEnv, [parent.id], { deleteBlob: gate.deleteBlob });
    await gate.deleteStarted;
    delayed.release();
    const uploadResult: Entry | Error = await uploadAttempt.then(
      (entry) => entry,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    if (!(uploadResult instanceof Error)) fixtureIds.push(uploadResult.id);
    gate.release();
    const deletionResult = await deletion;

    expect(uploadResult).toMatchObject({ status: 404, code: 'ENTRY_NOT_FOUND' });
    expect(deletionResult).toEqual({ succeeded: [parent.id], failed: [] });
    expect(await getEntryById(workerEnv.DB, late)).toBeNull();
    expect(await getEntryById(workerEnv.DB, parent.id)).toBeNull();
  });

  it('allows only the first concurrent deletion attempt to claim a tree', async () => {
    const parent = await folder('delete-race');
    const id = fileId('delete-race-file');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: parent.id, name: `${fixture}-x.txt`,
    });
    const gate = deletionGate();
    const first = deleteEntryTrees(workerEnv, [parent.id], { deleteBlob: gate.deleteBlob });

    await gate.deleteStarted;
    const second = await deleteEntryTrees(workerEnv, [parent.id]);
    gate.release();

    expect(second).toEqual({
      succeeded: [],
      failed: [{ id: parent.id, code: 'ENTRY_DELETE_IN_PROGRESS', message: 'Entry deletion is already in progress' }],
    });
    await expect(first).resolves.toEqual({ succeeded: [parent.id], failed: [] });
    expect(await getEntryById(workerEnv.DB, parent.id)).toBeNull();
  });

  it('returns mutation conflicts when delete claims a file before move or patch commits', async () => {
    const source = await folder('mutation-race-source');
    const destination = await folder('mutation-race-destination');
    const id = fileId('mutation-race-file');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: source.id, name: `${fixture}-x.txt`,
    });
    const gate = deletionGate();
    const deletion = deleteEntryTrees(workerEnv, [id], { deleteBlob: gate.deleteBlob });

    await gate.deleteStarted;
    await expect(patchEntry(workerEnv.DB, id, { description: 'too late' })).rejects.toMatchObject({
      status: 409, code: 'ENTRY_MUTATION_CONFLICT',
    });
    await expect(moveEntries(workerEnv.DB, [id], destination.id)).resolves.toEqual({
      succeeded: [],
      failed: [{ id, code: 'ENTRY_MUTATION_CONFLICT', message: 'Entry changed or deletion was claimed' }],
    });
    gate.release();
    await expect(deletion).resolves.toEqual({ succeeded: [id], failed: [] });
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

  it('keeps a failed tree deleting with durable retry state instead of restoring ready rows', async () => {
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
    const failureKey = (await getEntryById(workerEnv.DB, failureId))!.storage_key!;

    const result = await deleteEntryTrees(workerEnv, [parent.id], {
      deleteBlob: async (key) => {
        if (key === failureKey) throw new Error('R2 unavailable');
        await workerEnv.R2_BUCKET.delete(key);
      },
    });

    expect(result).toMatchObject({
      succeeded: [],
      failed: [{ id: parent.id, code: 'STORAGE_OPERATION_FAILED' }],
    });
    expect(await getEntryById(workerEnv.DB, successId)).toMatchObject({ status: 'deleting' });
    expect(await getEntryById(workerEnv.DB, failureId)).toMatchObject({ status: 'deleting' });
    expect(await getEntryById(workerEnv.DB, parent.id)).toMatchObject({ status: 'deleting' });
    expect(await listStorageRecoveryOperations(workerEnv.DB, parent.id)).toMatchObject([
      { operation_kind: 'delete_tree', state: 'retry' },
    ]);
  });

  it('retains a deleting tree when D1 fails after its blob was removed and finalizes it on replay', async () => {
    const id = fileId('metadata-failure');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: 'root', name: `${fixture}-metadata.txt`,
    });
    const key = (await getEntryById(workerEnv.DB, id))!.storage_key!;
    const failingEnv = {
      ...workerEnv,
      DB: dbWithFailure((sql) => sql.startsWith("DELETE FROM entries WHERE id = ? AND status = 'deleting'")),
    };

    await expect(deleteEntryTrees(failingEnv, [id])).resolves.toMatchObject({
      failed: [{ id, code: 'STORAGE_OPERATION_FAILED' }],
    });
    expect(await workerEnv.R2_BUCKET.get(key)).toBeNull();
    expect(await getEntryById(workerEnv.DB, id)).toMatchObject({ status: 'deleting' });

    await reconcileStorageRecovery(workerEnv);
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
  });

  it('keeps a failed upload cleanup durable when R2 deletion fails', async () => {
    const id = fileId('upload-cleanup');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    const failingEnv = {
      ...workerEnv,
      DB: dbWithFailure((sql) => sql.startsWith('UPDATE entries SET size =')),
      R2_BUCKET: bucketWith({ delete: async () => { throw new Error('R2 delete failed'); } }),
    };

    await expect(uploadFile(failingEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: 'root', name: `${fixture}-upload-cleanup.txt`,
    })).rejects.toMatchObject({ status: 502, code: 'STORAGE_OPERATION_FAILED' });
    const failedEntry = (await getEntryById(workerEnv.DB, id))!;
    expect(failedEntry).toMatchObject({ status: 'uploading', lifecycle_owner: expect.any(String) });
    expect(await workerEnv.R2_BUCKET.get(failedEntry.storage_key!)).not.toBeNull();
    expect(await listStorageRecoveryOperations(workerEnv.DB, id)).toMatchObject([
      { operation_kind: 'upload_cleanup', state: 'retry' },
    ]);

    await reconcileStorageRecovery(workerEnv);
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
    expect(await workerEnv.R2_BUCKET.get(failedEntry.storage_key!)).toBeNull();
  });

  it('claims a recovery operation once when reconciliation is invoked concurrently', async () => {
    const id = fileId('duplicate-reconcile');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    const seedFailure = {
      ...workerEnv,
      DB: dbWithFailure((sql) => sql.startsWith('UPDATE entries SET size =')),
      R2_BUCKET: bucketWith({ delete: async () => { throw new Error('R2 delete failed'); } }),
    };
    await expect(uploadFile(seedFailure, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: 'root', name: `${fixture}-duplicate.txt`,
    })).rejects.toMatchObject({ status: 502 });
    let deletes = 0;
    const countingEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        delete: async (key: string) => {
          deletes += 1;
          await workerEnv.R2_BUCKET.delete(key);
        },
      }),
    };

    await Promise.all([reconcileStorageRecovery(countingEnv), reconcileStorageRecovery(countingEnv)]);
    expect(deletes).toBe(1);
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
  });

  it('replays a delete after an unknown R2 outcome without restoring metadata', async () => {
    const id = fileId('crash-replay');
    fixtureIds.push(id);
    fixtureKeys.push(`blobs/${id}`);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: 'root', name: `${fixture}-crash.txt`,
    });
    let deletes = 0;
    const crashEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        delete: async (key: string) => {
          deletes += 1;
          await workerEnv.R2_BUCKET.delete(key);
          if (deletes === 1) throw new Error('worker stopped after R2 delete');
        },
      }),
    };

    await expect(deleteEntryTrees(crashEnv, [id])).resolves.toMatchObject({ failed: [{ id, code: 'STORAGE_OPERATION_FAILED' }] });
    expect(await getEntryById(workerEnv.DB, id)).toMatchObject({ status: 'deleting' });
    await reconcileStorageRecovery(crashEnv);
    expect(deletes).toBe(2);
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
  });

  it('does not delete a replacement upload owned by a different attempt', async () => {
    const id = fileId('owner-replacement');
    const key = `blobs/${id}`;
    fixtureIds.push(id);
    fixtureKeys.push(key);
    const seedFailure = {
      ...workerEnv,
      DB: dbWithFailure((sql) => sql.startsWith('UPDATE entries SET size =')),
      R2_BUCKET: bucketWith({ delete: async () => { throw new Error('R2 delete failed'); } }),
    };
    await expect(uploadFile(seedFailure, new Request('https://ilist.example/upload', { method: 'PUT', body: 'old' }), {
      id, parentId: 'root', name: `${fixture}-old.txt`,
    })).rejects.toMatchObject({ status: 502 });

    await workerEnv.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
    const now = new Date().toISOString();
    await workerEnv.DB.prepare(`INSERT INTO entries (
      id, parent_id, name, kind, storage_key, size, content_type, etag, status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
    ) VALUES (?, 'root', ?, 'file', ?, 0, NULL, NULL, 'uploading', 'replacement-owner', 1, 0, '', ?, ?)`).bind(
      id, `${fixture}-replacement.txt`, key, now, now,
    ).run();
    await workerEnv.R2_BUCKET.put(key, 'replacement');

    await reconcileStorageRecovery(workerEnv);
    expect(await workerEnv.R2_BUCKET.get(key)).not.toBeNull();
    expect(await getEntryById(workerEnv.DB, id)).toMatchObject({ lifecycle_owner: 'replacement-owner' });
  });

  it('keeps a replacement upload isolated from a stale delayed PUT and cleanup', async () => {
    const id = fileId('stale-put');
    fixtureIds.push(id);
    let beginPut!: () => void;
    let releasePut!: () => void;
    const putStarted = new Promise<void>((resolve) => { beginPut = resolve; });
    const putReleased = new Promise<void>((resolve) => { releasePut = resolve; });
    const staleEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        put: async (...args: Parameters<R2Bucket['put']>) => {
          beginPut();
          await putReleased;
          return await workerEnv.R2_BUCKET.put(...args);
        },
      }),
    };
    const stale = uploadFile(staleEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'stale' }), {
      id, parentId: 'root', name: `${fixture}-stale.txt`,
    });

    await putStarted;
    const staleKey = (await getEntryById(workerEnv.DB, id))!.storage_key!;
    fixtureKeys.push(staleKey);
    const staleOperation = (await listStorageRecoveryOperations(workerEnv.DB, id)).find((operation) => operation.state === 'held')!;
    await activateStorageRecoveryOperation(workerEnv.DB, staleOperation.id, 'cleanup_blob');
    await reconcileStorageRecovery(workerEnv);
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
    const replacement = await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'replacement' }), {
      id, parentId: 'root', name: `${fixture}-replacement.txt`,
    });
    const replacementKey = (await getEntryById(workerEnv.DB, id))!.storage_key!;
    fixtureKeys.push(replacementKey);

    expect(replacementKey).not.toBe(staleKey);
    releasePut();
    await expect(stale).rejects.toMatchObject({ status: 502, code: 'STORAGE_OPERATION_FAILED' });

    expect(await (await workerEnv.R2_BUCKET.get(replacementKey))!.text()).toBe('replacement');
    expect(replacement).toMatchObject({ id });
  });

  it('keeps a replacement upload isolated from a stale delayed delete', async () => {
    const id = fileId('stale-delete');
    fixtureIds.push(id);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'old' }), {
      id, parentId: 'root', name: `${fixture}-old.txt`,
    });
    const staleKey = (await getEntryById(workerEnv.DB, id))!.storage_key!;
    fixtureKeys.push(staleKey);
    const gate = deletionGate();
    const staleDelete = deleteEntryTrees(workerEnv, [id], { deleteBlob: gate.deleteBlob });

    await gate.deleteStarted;
    await workerEnv.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
    const replacement = await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'replacement' }), {
      id, parentId: 'root', name: `${fixture}-replacement.txt`,
    });
    const replacementKey = (await getEntryById(workerEnv.DB, id))!.storage_key!;
    fixtureKeys.push(replacementKey);
    expect(replacementKey).not.toBe(staleKey);

    gate.release();
    await expect(staleDelete).resolves.toEqual({ succeeded: [id], failed: [] });
    expect(await (await workerEnv.R2_BUCKET.get(replacementKey))!.text()).toBe('replacement');
    expect(replacement).toMatchObject({ id });
  });

  it('renews a recovery claim during a delayed R2 delete so a second worker cannot take it', async () => {
    const id = fileId('recovery-heartbeat');
    fixtureIds.push(id);
    await uploadFile(workerEnv, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id, parentId: 'root', name: `${fixture}-recovery-heartbeat.txt`,
    });
    const key = (await getEntryById(workerEnv.DB, id))!.storage_key!;
    fixtureKeys.push(key);
    const seed = await deleteEntryTrees(workerEnv, [id], { deleteBlob: async () => { throw new Error('seed retry'); } });
    expect(seed).toMatchObject({ failed: [{ id, code: 'STORAGE_OPERATION_FAILED' }] });

    let clock = 0;
    let heartbeat: () => Promise<void> = async () => undefined;
    let startDelete!: () => void;
    let releaseDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { startDelete = resolve; });
    const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let deletes = 0;
    const delayedEnv = {
      ...workerEnv,
      R2_BUCKET: bucketWith({
        delete: async (deleteKey: string) => {
          deletes += 1;
          if (deletes === 1) {
            startDelete();
            await deleteReleased;
          }
          await workerEnv.R2_BUCKET.delete(deleteKey);
        },
      }),
    };
    const first = reconcileStorageRecovery(delayedEnv, {
      now: () => clock,
      recoveryHeartbeat: {
        now: () => clock,
        heartbeatIntervalMs: 1,
        setInterval: (callback) => {
          heartbeat = callback;
          return 'recovery-heartbeat';
        },
        clearInterval: () => undefined,
      },
    });

    await deleteStarted;
    clock = 20_000;
    await heartbeat();
    clock = 31_000;
    await expect(reconcileStorageRecovery(delayedEnv, { now: () => clock })).resolves.toEqual({
      processed: 0, completed: 0, retried: 0,
    });
    releaseDelete();
    await expect(first).resolves.toEqual({ processed: 1, completed: 1, retried: 0 });
    expect(deletes).toBe(1);
    expect(await getEntryById(workerEnv.DB, id)).toBeNull();
  });

  it('enforces maxEntries for folder-only trees before claiming deletion', async () => {
    const exact = await folder('limit-exact');
    const exactChild = await createFolder(workerEnv.DB, { parentId: exact.id, name: `${fixture}-limit-exact-child` });
    const exactGrandchild = await createFolder(workerEnv.DB, { parentId: exactChild.id, name: `${fixture}-limit-exact-grandchild` });
    fixtureIds.push(exactChild.id, exactGrandchild.id);

    await expect(deleteEntryTrees(workerEnv, [exact.id], { maxEntries: 3 })).resolves.toEqual({
      succeeded: [exact.id], failed: [],
    });

    const tooLarge = await folder('limit-plus-one');
    const child = await createFolder(workerEnv.DB, { parentId: tooLarge.id, name: `${fixture}-limit-plus-one-child` });
    const grandchild = await createFolder(workerEnv.DB, { parentId: child.id, name: `${fixture}-limit-plus-one-grandchild` });
    const greatGrandchild = await createFolder(workerEnv.DB, { parentId: grandchild.id, name: `${fixture}-limit-plus-one-great-grandchild` });
    fixtureIds.push(child.id, grandchild.id, greatGrandchild.id);

    await expect(deleteEntryTrees(workerEnv, [tooLarge.id], { maxEntries: 3 })).resolves.toEqual({
      succeeded: [],
      failed: [{ id: tooLarge.id, code: 'OPERATION_LIMIT_EXCEEDED', message: 'Delete contains too many entries' }],
    });
    await expect(getEntryById(workerEnv.DB, tooLarge.id)).resolves.toMatchObject({ status: 'ready' });
    await expect(getEntryById(workerEnv.DB, greatGrandchild.id)).resolves.toMatchObject({ status: 'ready' });
  });
});
