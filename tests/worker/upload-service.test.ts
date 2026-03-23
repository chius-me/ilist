import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driverRegistry } from '../../src/worker/drivers/registry';
import { S3Error } from '../../src/worker/drivers/s3/client';
import { S3Driver, type S3DriverClient } from '../../src/worker/drivers/s3/driver';
import {
  LARGE_UPLOAD_THRESHOLD_BYTES,
  UPLOAD_PART_SIZE_BYTES,
  type ProviderUploadPartResult,
  type ResumableUploadAdapter,
  type StorageDriver,
  type StorageItem,
} from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { HttpError } from '../../src/worker/http';
import { createMount } from '../../src/worker/mounts';
import {
  abortResumableUpload,
  cleanupExpiredUploads,
  completeResumableUpload,
  createResumableUpload,
  getResumableUpload,
  uploadResumablePart,
} from '../../src/worker/upload-service';
import { claimCompletion } from '../../src/worker/upload-session-store';
import type { Env, Mount } from '../../src/worker/types';

const ownerSessionId = 'upload-service-owner';
const otherOwnerSessionId = 'upload-service-other-owner';
const originalOneDriveFactory = driverRegistry.onedrive;
const originalS3Factory = driverRegistry.s3;

const workerEnv = () => env as unknown as Env;

function storageItem(overrides: Partial<StorageItem> = {}): StorageItem {
  return {
    id: 'completed-item',
    parentId: 'folder',
    name: 'archive.bin',
    kind: 'file',
    size: 25 * 1024 * 1024,
    contentType: 'application/octet-stream',
    modifiedAt: '2026-07-17T00:00:00.000Z',
    etag: 'completed-etag',
    ...overrides,
  };
}

function fakeDriver(
  label: string,
  overrides: Partial<ResumableUploadAdapter> = {},
  options: { multipart?: boolean } = {},
): StorageDriver {
  const adapter: ResumableUploadAdapter = {
    create: vi.fn(async () => ({
      state: {
        uploadUrl: `https://upload.example/${label}?token=private`,
        uploadId: `private-${label}-upload-id`,
        integrityProof: `private-${label}-proof`,
      },
      expiresAt: Date.now() + 60 * 60_000,
    })),
    uploadPart: vi.fn(async (input): Promise<ProviderUploadPartResult> => ({
      state: { ...input.state, checkpoint: input.partNumber },
      part: { partNumber: input.partNumber, size: input.size, etag: `etag-${input.partNumber}` },
    })),
    complete: vi.fn(async () => storageItem()),
    abort: vi.fn(async () => undefined),
    ...overrides,
  };
  const multipart = options.multipart ?? true;
  return {
    rootId: 'root',
    capabilities: new Set([
      'list',
      'upload',
      ...(multipart ? ['multipartUpload' as const] : []),
    ]),
    ...(multipart ? { resumableUpload: adapter } : {}),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    stat: vi.fn(async (id) => id === 'file'
      ? storageItem({ id: 'file', kind: 'file' })
      : storageItem({ id, name: id, kind: 'folder', size: null, contentType: null })),
    getDownload: vi.fn(async () => ({ kind: 'redirect' as const, url: 'https://download.example/file' })),
    createFolder: vi.fn(async () => storageItem({ kind: 'folder' })),
    upload: vi.fn(async () => storageItem()),
    rename: vi.fn(async () => storageItem()),
    move: vi.fn(async () => storageItem()),
    remove: vi.fn(async () => undefined),
  };
}

async function insertOwner(id: string): Promise<void> {
  await workerEnv().DB.prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)')
    .bind(id, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000))
    .run();
}

async function mount(driverType: 'onedrive' | 's3' = 'onedrive', name: string = crypto.randomUUID()): Promise<Mount> {
  return createMount(workerEnv().DB, {
    name: `Upload ${name}`,
    mountPath: `/upload-${name}`,
    driverType,
    provider: driverType,
    config: driverType === 's3'
      ? { endpoint: 'https://s3.example', region: 'auto', bucket: 'uploads', addressingMode: 'path' }
      : {},
  });
}

function createInput(mounted: Mount, overrides: Record<string, unknown> = {}) {
  return {
    parentId: encodeExternalId(mounted.id, 'folder'),
    name: 'archive.bin',
    size: 25 * 1024 * 1024,
    contentType: 'application/octet-stream',
    ...overrides,
  };
}

function partRequest(size: number, signal?: AbortSignal): Request {
  return new Request('https://ilist.example/api/admin/uploads/part', {
    method: 'PUT',
    headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
    body: 'x',
    signal,
  });
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
          return statementTarget.run<T>();
        };
      }
      const value = Reflect.get(statementTarget, statementProperty, statementTarget);
      return typeof value === 'function' ? value.bind(statementTarget) : value;
    },
  }) as D1PreparedStatement;
  return new Proxy(workerEnv().DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => wrap(target.prepare(sql), sql.replace(/\s+/g, ' ').trim());
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

function envWithDb(db: D1Database): Env {
  return new Proxy(workerEnv(), {
    get(target, property) {
      if (property === 'DB') return db;
      return Reflect.get(target, property, target);
    },
  });
}

function s3Client(overrides: Partial<S3DriverClient> = {}): S3DriverClient {
  return {
    listObjectsV2: vi.fn(async () => ({
      objects: [], commonPrefixes: [], nextContinuationToken: null, isTruncated: false, keyCount: 0,
    })),
    headObject: vi.fn(async () => new Response(null)),
    getObject: vi.fn(async () => new Response()),
    putObject: vi.fn(async () => new Response()),
    copyObject: vi.fn(async () => new Response()),
    deleteObject: vi.fn(async () => new Response()),
    createMultipartUpload: vi.fn(async () => ({ uploadId: 'upload-123' })),
    uploadPart: vi.fn(async (_key, _uploadId, partNumber) => ({ etag: `"part-${partNumber}"` })),
    completeMultipartUpload: vi.fn(async () => ({ etag: '"complete"' })),
    abortMultipartUpload: vi.fn(async () => new Response(null, { status: 204 })),
    ...overrides,
  };
}

async function expire(id: string): Promise<void> {
  await workerEnv().DB.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?')
    .bind(Date.now() - 1, id)
    .run();
}

describe('upload lifecycle service', () => {
  beforeEach(async () => {
    await workerEnv().DB.prepare('DELETE FROM upload_sessions').run();
    await workerEnv().DB.prepare('DELETE FROM sessions').run();
    await workerEnv().DB.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
    await insertOwner(ownerSessionId);
    await insertOwner(otherOwnerSessionId);
  });

  afterEach(() => {
    driverRegistry.onedrive = originalOneDriveFactory;
    driverRegistry.s3 = originalS3Factory;
  });

  it('creates a safe server-sized session only for a supported external folder', async () => {
    const mounted = await mount();
    const driver = fakeDriver('supported');
    driverRegistry.onedrive = () => driver;

    const view = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));

    expect(view).toEqual({
      id: expect.any(String),
      kind: 'multipart',
      partSize: 10 * 1024 * 1024,
      size: 25 * 1024 * 1024,
      uploadedParts: [],
      expiresAt: expect.any(String),
      status: 'active',
    });
    expect(driver.resumableUpload?.create).toHaveBeenCalledWith({
      parentId: 'folder',
      name: 'archive.bin',
      size: 25 * 1024 * 1024,
      contentType: 'application/octet-stream',
      partSize: UPLOAD_PART_SIZE_BYTES,
    });
    expect(JSON.stringify(view)).not.toMatch(/uploadUrl|uploadId|integrityProof|private/);

    await expect(createResumableUpload(workerEnv(), ownerSessionId, {
      ...createInput(mounted), parentId: 'root',
    })).rejects.toMatchObject({ code: 'UPLOAD_SESSION_UNSUPPORTED' });
    await expect(createResumableUpload(workerEnv(), ownerSessionId, {
      ...createInput(mounted), parentId: encodeExternalId(mounted.id, 'file'),
    })).rejects.toMatchObject({ code: 'UPLOAD_SESSION_UNSUPPORTED' });

    driverRegistry.onedrive = () => fakeDriver('simple', {}, { multipart: false });
    await expect(createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted)))
      .rejects.toMatchObject({ code: 'UPLOAD_SESSION_UNSUPPORTED' });
  });

  it.each([
    ['below threshold', LARGE_UPLOAD_THRESHOLD_BYTES - 1],
    ['fractional', LARGE_UPLOAD_THRESHOLD_BYTES + 0.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s declared upload size', async (_label, size) => {
    const mounted = await mount();
    driverRegistry.onedrive = () => fakeDriver('invalid-size');

    await expect(createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, { size })))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
  });

  it('rejects a client-supplied part size', async () => {
    const mounted = await mount();
    const driver = fakeDriver('client-part-size');
    driverRegistry.onedrive = () => driver;

    await expect(createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, { partSize: 1 })))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
    expect(driver.resumableUpload?.create).not.toHaveBeenCalled();
  });

  it('accepts exactly numbered full and final parts and forwards the request signal', async () => {
    const mounted = await mount();
    const driver = fakeDriver('parts');
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));
    const controller = new AbortController();

    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES, controller.signal),
    )).resolves.toEqual({ partNumber: 1, size: UPLOAD_PART_SIZE_BYTES });
    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 2, partRequest(UPLOAD_PART_SIZE_BYTES),
    )).resolves.toEqual({ partNumber: 2, size: UPLOAD_PART_SIZE_BYTES });
    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 3, partRequest(5 * 1024 * 1024),
    )).resolves.toEqual({ partNumber: 3, size: 5 * 1024 * 1024 });

    expect(driver.resumableUpload?.uploadPart).toHaveBeenNthCalledWith(1, expect.objectContaining({
      partNumber: 1,
      offset: 0,
      totalSize: 25 * 1024 * 1024,
      size: UPLOAD_PART_SIZE_BYTES,
      signal: controller.signal,
    }));
    expect(driver.resumableUpload?.uploadPart).toHaveBeenNthCalledWith(3, expect.objectContaining({
      partNumber: 3,
      offset: 20 * 1024 * 1024,
      size: 5 * 1024 * 1024,
    }));
    await expect(getResumableUpload(workerEnv(), ownerSessionId, session.id)).resolves.toMatchObject({
      uploadedParts: [
        { partNumber: 1, size: UPLOAD_PART_SIZE_BYTES },
        { partNumber: 2, size: UPLOAD_PART_SIZE_BYTES },
        { partNumber: 3, size: 5 * 1024 * 1024 },
      ],
    });
  });

  it.each([0, 4, 1.5])('rejects invalid part number %s', async (partNumber) => {
    const mounted = await mount();
    driverRegistry.onedrive = () => fakeDriver('invalid-part');
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));

    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, partNumber, partRequest(UPLOAD_PART_SIZE_BYTES),
    )).rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
  });

  it('requires the exact content length and a request body before taking a claim', async () => {
    const mounted = await mount();
    const driver = fakeDriver('invalid-length');
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));
    const missingLength = new Request('https://ilist.example/part', { method: 'PUT', body: 'x' });
    const missingBody = new Request('https://ilist.example/part', {
      method: 'PUT', headers: { 'content-length': String(UPLOAD_PART_SIZE_BYTES) },
    });

    await expect(uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, missingLength))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
    await expect(uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, partRequest(1)))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
    await expect(uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, missingBody))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
    expect(driver.resumableUpload?.uploadPart).not.toHaveBeenCalled();
  });

  it('uses a five-minute claim, returns matching duplicate retries, and releases provider failures', async () => {
    const mounted = await mount();
    let rejectUpload: ((error: Error) => void) | undefined;
    const uploadPart = vi.fn((input: Parameters<ResumableUploadAdapter['uploadPart']>[0]) => new Promise<ProviderUploadPartResult>((_resolve, reject) => {
      rejectUpload = reject;
      expect(input.partNumber).toBe(1);
    }));
    const driver = fakeDriver('claims', { uploadPart });
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));
    const startedAt = Date.now();
    const pending = uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    );

    await vi.waitFor(async () => {
      const row = await workerEnv().DB.prepare(
        'SELECT active_part_number, active_part_expires_at FROM upload_sessions WHERE id = ?',
      ).bind(session.id).first<{ active_part_number: number | null; active_part_expires_at: number | null }>();
      expect(row?.active_part_number).toBe(1);
      expect(row?.active_part_expires_at).toBeGreaterThanOrEqual(startedAt + 5 * 60_000);
      expect(row?.active_part_expires_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    });
    rejectUpload!(new Error('provider unavailable'));
    await expect(pending).rejects.toMatchObject({ code: 'UPLOAD_PROVIDER_FAILED' });
    await expect(workerEnv().DB.prepare(
      'SELECT active_part_number FROM upload_sessions WHERE id = ?',
    ).bind(session.id).first<{ active_part_number: number | null }>()).resolves.toEqual({ active_part_number: null });

    const successful = fakeDriver('claims-success');
    driverRegistry.onedrive = () => successful;
    const first = await uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    );
    const duplicate = await uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    );
    expect(duplicate).toEqual(first);
    expect(successful.resumableUpload?.uploadPart).toHaveBeenCalledTimes(1);
  });

  it('returns delayed matching part retries after completion starts or finishes and rejects conflicting stored metadata', async () => {
    const mounted = await mount();
    let rejectComplete!: (error: Error) => void;
    const complete = vi.fn()
      .mockImplementationOnce(() => new Promise<StorageItem>((_resolve, reject) => { rejectComplete = reject; }))
      .mockResolvedValueOnce(storageItem({ size: UPLOAD_PART_SIZE_BYTES }));
    const driver = fakeDriver('delayed-part', { complete });
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, {
      size: UPLOAD_PART_SIZE_BYTES,
    }));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES));

    const pending = completeResumableUpload(workerEnv(), ownerSessionId, session.id);
    await vi.waitFor(async () => {
      await expect(workerEnv().DB.prepare('SELECT status FROM upload_sessions WHERE id = ?')
        .bind(session.id).first()).resolves.toEqual({ status: 'completing' });
    });
    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    )).resolves.toEqual({ partNumber: 1, size: UPLOAD_PART_SIZE_BYTES });

    rejectComplete(new Error('retry completion'));
    await expect(pending).rejects.toMatchObject({ code: 'UPLOAD_PROVIDER_FAILED' });
    await completeResumableUpload(workerEnv(), ownerSessionId, session.id);
    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    )).resolves.toEqual({ partNumber: 1, size: UPLOAD_PART_SIZE_BYTES });
    expect(driver.resumableUpload?.uploadPart).toHaveBeenCalledTimes(1);

    const conflicting = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, {
      size: UPLOAD_PART_SIZE_BYTES,
    }));
    await uploadResumablePart(workerEnv(), ownerSessionId, conflicting.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES));
    const now = Date.now();
    await claimCompletion(workerEnv(), ownerSessionId, conflicting.id, 'delayed-conflict', now + 5 * 60_000, now);
    await workerEnv().DB.prepare('UPDATE upload_sessions SET parts_json = ? WHERE id = ?')
      .bind('[{"partNumber":1,"size":1,"etag":"different"}]', conflicting.id)
      .run();
    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, conflicting.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    )).rejects.toMatchObject({ code: 'UPLOAD_PART_INVALID' });
  });

  it('holds an exclusive five-minute completion lease and releases provider failures for retry', async () => {
    const mounted = await mount();
    let rejectComplete!: (error: Error) => void;
    const complete = vi.fn()
      .mockImplementationOnce(() => new Promise<StorageItem>((_resolve, reject) => { rejectComplete = reject; }))
      .mockResolvedValueOnce(storageItem({ size: UPLOAD_PART_SIZE_BYTES }));
    const driver = fakeDriver('completion-lease', { complete });
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, {
      size: UPLOAD_PART_SIZE_BYTES,
    }));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES));
    const startedAt = Date.now();
    const pending = completeResumableUpload(workerEnv(), ownerSessionId, session.id);

    await vi.waitFor(async () => {
      const row = await workerEnv().DB.prepare(
        'SELECT completion_owner, completion_expires_at FROM upload_sessions WHERE id = ?',
      ).bind(session.id).first<{ completion_owner: string | null; completion_expires_at: number | null }>();
      expect(row?.completion_owner).toEqual(expect.any(String));
      expect(row?.completion_expires_at).toBeGreaterThanOrEqual(startedAt + 5 * 60_000);
      expect(row?.completion_expires_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    });
    await expect(completeResumableUpload(workerEnv(), ownerSessionId, session.id))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_BUSY' });
    expect(complete).toHaveBeenCalledTimes(1);

    rejectComplete(new Error('provider unavailable'));
    await expect(pending).rejects.toMatchObject({ code: 'UPLOAD_PROVIDER_FAILED' });
    await expect(workerEnv().DB.prepare(
      'SELECT status, completion_owner, completion_expires_at FROM upload_sessions WHERE id = ?',
    ).bind(session.id).first()).resolves.toEqual({
      status: 'active', completion_owner: null, completion_expires_at: null,
    });
    await expect(completeResumableUpload(workerEnv(), ownerSessionId, session.id)).resolves.toHaveProperty('entry');
  });

  it('recovers S3 completion when provider success is followed by one local persistence failure', async () => {
    const mounted = await mount('s3', 'persist-complete');
    let marker = '';
    const complete = vi.fn()
      .mockResolvedValueOnce({ etag: '"complete"' })
      .mockRejectedValueOnce(new S3Error(404, 'NoSuchUpload', 'already completed'));
    const api = s3Client({
      createMultipartUpload: vi.fn(async (_key, _contentType, value) => {
        marker = value;
        return { uploadId: 'upload-123' };
      }),
      completeMultipartUpload: complete,
      headObject: vi.fn(async () => new Response(null, { headers: {
        'content-length': String(25 * 1024 * 1024),
        'x-amz-meta-ilist-upload-marker': marker,
        etag: '"complete"',
      } })),
    });
    const driver = new S3Driver(mounted, api);
    driverRegistry.s3 = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, {
      parentId: encodeExternalId(mounted.id, driver.rootId),
    }));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 2, partRequest(UPLOAD_PART_SIZE_BYTES));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 3, partRequest(5 * 1024 * 1024));
    const failingEnv = envWithDb(dbWithFailure((sql) => sql.includes("SET status = 'completed'")));

    await expect(completeResumableUpload(failingEnv, ownerSessionId, session.id))
      .rejects.toMatchObject({ code: 'UPLOAD_STATE_PERSIST_FAILED' });
    await expect(workerEnv().DB.prepare('SELECT status FROM upload_sessions WHERE id = ?')
      .bind(session.id).first()).resolves.toEqual({ status: 'active' });

    const result = await completeResumableUpload(workerEnv(), ownerSessionId, session.id);
    expect(result.entry).toMatchObject({ name: 'archive.bin', size: 25 * 1024 * 1024 });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(api.headObject).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('lets cleanup converge an S3 abort after provider success and one local persistence failure', async () => {
    const mounted = await mount('s3', 'persist-abort');
    const abort = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new S3Error(404, 'NoSuchUpload', 'already absent'));
    const api = s3Client({ abortMultipartUpload: abort });
    const driver = new S3Driver(mounted, api);
    driverRegistry.s3 = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted, {
      parentId: encodeExternalId(mounted.id, driver.rootId),
    }));
    const failingEnv = envWithDb(dbWithFailure((sql) => sql.includes("SET status = 'aborted'")));

    await expect(abortResumableUpload(failingEnv, ownerSessionId, session.id))
      .rejects.toMatchObject({ code: 'UPLOAD_STATE_PERSIST_FAILED' });
    await expire(session.id);
    await cleanupExpiredUploads(workerEnv(), 1);

    expect(abort).toHaveBeenCalledTimes(2);
    await expect(workerEnv().DB.prepare('SELECT status FROM upload_sessions WHERE id = ?')
      .bind(session.id).first()).resolves.toEqual({ status: 'aborted' });
  });

  it('sanitizes hostile provider HttpErrors and maps retryable S3 failures to stable errors', async () => {
    const mounted = await mount();
    const uploadPart = vi.fn();
    const driver = fakeDriver('provider-errors', { uploadPart });
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));
    const cases = [
      [new S3Error(503, 'SlowDown', 'private slowdown', null, null, 30), 'UPLOAD_PROVIDER_RATE_LIMITED', 30],
      [new S3Error(429, 'Throttling', 'private throttle'), 'UPLOAD_PROVIDER_RATE_LIMITED', undefined],
      [new S3Error(408, 'RequestTimeout', 'private timeout'), 'UPLOAD_PROVIDER_RETRYABLE', undefined],
      [new S3Error(503, 'ServiceUnavailable', 'private outage', null, null, 10), 'UPLOAD_PROVIDER_RETRYABLE', 10],
    ] as const;

    for (const [providerError, code, retryAfter] of cases) {
      uploadPart.mockRejectedValueOnce(providerError);
      const error = await uploadResumablePart(
        workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
      ).catch((caught: unknown) => caught) as HttpError;
      expect(error).toMatchObject({ status: 503, code });
      expect(error.details).toEqual(retryAfter === undefined ? undefined : { retryAfter });
      expect(error.message).not.toContain(providerError.message);
    }

    uploadPart.mockRejectedValueOnce(new HttpError(418, 'HOSTILE_PROVIDER_ERROR', 'uploadUrl=https://private', {
      uploadUrl: 'https://upload.example/private', uploadId: 'private-id', proof: 'private-proof', retryAfter: Infinity,
    }));
    const hostile = await uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    ).catch((caught: unknown) => caught) as HttpError;
    expect(hostile).toMatchObject({ status: 502, code: 'UPLOAD_PROVIDER_FAILED', details: undefined });
    expect(JSON.stringify({ message: hostile.message, details: hostile.details }))
      .not.toMatch(/uploadUrl|uploadId|proof|private/);
  });

  it('requires every expected part before completing and returns the completed entry idempotently', async () => {
    const mounted = await mount('s3');
    const driver = fakeDriver('completion');
    driverRegistry.s3 = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES));
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 3, partRequest(5 * 1024 * 1024));

    await expect(completeResumableUpload(workerEnv(), ownerSessionId, session.id))
      .rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    await uploadResumablePart(workerEnv(), ownerSessionId, session.id, 2, partRequest(UPLOAD_PART_SIZE_BYTES));

    const completed = await completeResumableUpload(workerEnv(), ownerSessionId, session.id);
    const repeated = await completeResumableUpload(workerEnv(), ownerSessionId, session.id);
    const delayedPart = await uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    );
    expect(completed).toEqual(repeated);
    expect(delayedPart).toEqual({ partNumber: 1, size: UPLOAD_PART_SIZE_BYTES });
    expect(completed.entry).toMatchObject({
      id: encodeExternalId(mounted.id, 'completed-item'),
      mountId: mounted.id,
      kind: 'file',
    });
    expect(driver.resumableUpload?.complete).toHaveBeenCalledTimes(1);
    expect(driver.resumableUpload?.complete).toHaveBeenCalledWith(expect.objectContaining({
      parts: [
        { partNumber: 1, size: UPLOAD_PART_SIZE_BYTES, etag: 'etag-1' },
        { partNumber: 2, size: UPLOAD_PART_SIZE_BYTES, etag: 'etag-2' },
        { partNumber: 3, size: 5 * 1024 * 1024, etag: 'etag-3' },
      ],
    }));
    expect(JSON.stringify(completed)).not.toMatch(/uploadUrl|uploadId|integrityProof|private/);
  });

  it('aborts upstream before marking the session and makes cancellation idempotent', async () => {
    const mounted = await mount();
    const driver = fakeDriver('abort');
    driverRegistry.onedrive = () => driver;
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));

    await abortResumableUpload(workerEnv(), ownerSessionId, session.id);
    await abortResumableUpload(workerEnv(), ownerSessionId, session.id);

    expect(driver.resumableUpload?.abort).toHaveBeenCalledTimes(1);
    await expect(getResumableUpload(workerEnv(), ownerSessionId, session.id)).resolves.toMatchObject({ status: 'aborted' });
  });

  it('isolates owners and rejects new parts after expiration', async () => {
    const mounted = await mount();
    driverRegistry.onedrive = () => fakeDriver('isolation');
    const session = await createResumableUpload(workerEnv(), ownerSessionId, createInput(mounted));

    await expect(getResumableUpload(workerEnv(), otherOwnerSessionId, session.id))
      .rejects.toMatchObject({ code: 'UPLOAD_SESSION_NOT_FOUND' });
    await expire(session.id);
    await expect(uploadResumablePart(
      workerEnv(), ownerSessionId, session.id, 1, partRequest(UPLOAD_PART_SIZE_BYTES),
    )).rejects.toMatchObject({ code: 'UPLOAD_SESSION_EXPIRED' });
  });

  it('cleans a bounded number of expired sessions with each correct mount driver and continues after failures', async () => {
    const firstMount = await mount('onedrive', 'cleanup-one');
    const secondMount = await mount('s3', 'cleanup-two');
    const firstDriver = fakeDriver('cleanup-one', { abort: vi.fn(async () => { throw new Error('abort failed'); }) });
    const secondDriver = fakeDriver('cleanup-two');
    driverRegistry.onedrive = (_env, candidate) => {
      expect(candidate.id).toBe(firstMount.id);
      return firstDriver;
    };
    driverRegistry.s3 = (_env, candidate) => {
      expect(candidate.id).toBe(secondMount.id);
      return secondDriver;
    };
    const first = await createResumableUpload(workerEnv(), ownerSessionId, createInput(firstMount));
    const second = await createResumableUpload(workerEnv(), ownerSessionId, createInput(secondMount));
    await expire(first.id);
    await expire(second.id);

    await cleanupExpiredUploads(workerEnv(), 2);

    expect(firstDriver.resumableUpload?.abort).toHaveBeenCalledTimes(1);
    expect(secondDriver.resumableUpload?.abort).toHaveBeenCalledTimes(1);
    await expect(workerEnv().DB.prepare('SELECT status FROM upload_sessions WHERE id = ?')
      .bind(first.id).first()).resolves.toEqual({ status: 'active' });
    await expect(workerEnv().DB.prepare('SELECT status FROM upload_sessions WHERE id = ?')
      .bind(second.id).first()).resolves.toEqual({ status: 'aborted' });
  });
});
