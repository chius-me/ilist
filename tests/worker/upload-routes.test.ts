import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentAdminSession } from '../../src/worker/auth';
import { driverRegistry } from '../../src/worker/drivers/registry';
import {
  UPLOAD_PART_SIZE_BYTES,
  type ResumableUploadAdapter,
  type StorageDriver,
  type StorageItem,
} from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { HttpError } from '../../src/worker/http';
import { createMount } from '../../src/worker/mounts';
import { claimUploadPart } from '../../src/worker/upload-session-store';
import type { Env, Mount } from '../../src/worker/types';

const origin = 'https://ilist.example';
const originalOneDriveFactory = driverRegistry.onedrive;

const workerEnv = () => env as unknown as Env;

function item(overrides: Partial<StorageItem> = {}): StorageItem {
  return {
    id: 'completed-item',
    parentId: 'folder/with unicode 文档',
    name: 'archive.bin',
    kind: 'file',
    size: UPLOAD_PART_SIZE_BYTES,
    contentType: 'application/octet-stream',
    modifiedAt: '2026-07-17T00:00:00.000Z',
    etag: 'completed-etag',
    ...overrides,
  };
}

function fakeDriver(overrides: Partial<ResumableUploadAdapter> = {}): StorageDriver {
  const adapter: ResumableUploadAdapter = {
    create: vi.fn(async () => ({
      state: {
        providerState: 'private-state',
        uploadUrl: 'https://upload.example/session?token=private',
        uploadId: 'private-upload-id',
        integrityProof: 'private-proof',
      },
      expiresAt: Date.now() + 60 * 60_000,
    })),
    uploadPart: vi.fn(async (input) => ({
      state: { ...input.state, proof: 'updated-private-proof' },
      part: { partNumber: input.partNumber, size: input.size, etag: null },
      completedItem: item({ parentId: 'folder/with unicode 文档' }),
    })),
    complete: vi.fn(async (input) => input.completedItem ?? item()),
    abort: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    rootId: 'root',
    capabilities: new Set(['list', 'upload', 'multipartUpload']),
    resumableUpload: adapter,
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    stat: vi.fn(async (id) => item({ id, name: 'Uploads', kind: 'folder', size: null, contentType: null })),
    getDownload: vi.fn(async () => ({ kind: 'redirect' as const, url: 'https://download.example/file' })),
    createFolder: vi.fn(async () => item({ kind: 'folder' })),
    upload: vi.fn(async () => item()),
    rename: vi.fn(async () => item()),
    move: vi.fn(async () => item()),
    remove: vi.fn(async () => undefined),
  };
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function createUploadMount(): Promise<Mount> {
  return createMount(workerEnv().DB, {
    name: 'Route Uploads',
    mountPath: '/route-uploads',
    driverType: 'onedrive',
    provider: 'onedrive',
  });
}

async function createSession(
  cookie: string,
  mounted: Mount,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return SELF.fetch(`${origin}/api/admin/uploads/sessions`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      parentId: encodeExternalId(mounted.id, 'folder/with unicode 文档'),
      name: 'archive.bin',
      size: UPLOAD_PART_SIZE_BYTES,
      contentType: 'application/octet-stream',
      ...body,
    }),
  });
}

async function responseData<T>(response: Response): Promise<T> {
  return (await response.json() as { data: T }).data;
}

async function sessionId(response: Response): Promise<string> {
  return (await responseData<{ id: string }>(response)).id;
}

function partRequest(cookie: string, id: string, options: { length?: number; originHeader?: string } = {}): Request {
  const headers = new Headers({
    cookie,
    origin: options.originHeader ?? origin,
    'content-type': 'application/octet-stream',
  });
  if (options.length !== undefined) headers.set('content-length', String(options.length));
  return new Request(`${origin}/api/admin/uploads/sessions/${id}/parts/1`, {
    method: 'PUT', headers, body: 'x',
  });
}

function forbiddenResponseKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenResponseKeys(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const forbidden = new Set([
    'providerState', 'state', 'proof', 'integrityProof', 'uploadUrl', 'url', 'uploadId',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) found.push(key);
    forbiddenResponseKeys(child, found);
  }
  return found;
}

describe('admin upload session routes', () => {
  beforeEach(async () => {
    await workerEnv().DB.prepare('DELETE FROM upload_sessions').run();
    await workerEnv().DB.prepare('DELETE FROM sessions').run();
    await workerEnv().DB.prepare("DELETE FROM mounts WHERE id <> 'native-r2'").run();
  });

  afterEach(() => {
    driverRegistry.onedrive = originalOneDriveFactory;
  });

  it('requires authentication once and same-origin protection for session creation', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver();
    driverRegistry.onedrive = () => driver;
    const body = JSON.stringify({
      parentId: encodeExternalId(mounted.id, 'folder/with unicode 文档'),
      name: 'archive.bin',
      size: UPLOAD_PART_SIZE_BYTES,
    });

    const unauthenticated = await SELF.fetch(`${origin}/api/admin/uploads/sessions`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body,
    });
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json() as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');

    const cookie = await login();
    const missingOrigin = await SELF.fetch(`${origin}/api/admin/uploads/sessions`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body,
    });
    expect(missingOrigin.status).toBe(403);
    expect((await missingOrigin.json() as { error: { code: string } }).error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(driver.resumableUpload?.create).not.toHaveBeenCalled();
  });

  it('creates and reads a session with an encoded provider parent ID', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver();
    driverRegistry.onedrive = () => driver;
    const cookie = await login();

    const created = await createSession(cookie, mounted);
    expect(created.status).toBe(200);
    const view = await responseData<Record<string, unknown>>(created.clone());
    expect(view).toEqual({
      id: expect.any(String),
      kind: 'multipart',
      partSize: UPLOAD_PART_SIZE_BYTES,
      size: UPLOAD_PART_SIZE_BYTES,
      uploadedParts: [],
      expiresAt: expect.any(String),
      status: 'active',
    });
    expect(driver.resumableUpload?.create).toHaveBeenCalledWith(expect.objectContaining({
      parentId: 'folder/with unicode 文档',
    }));

    const read = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${view.id}`, { headers: { cookie } });
    expect(read.status).toBe(200);
    await expect(responseData(read)).resolves.toEqual(view);
  });

  it('rejects invalid JSON and a client-supplied part size', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver();
    driverRegistry.onedrive = () => driver;
    const cookie = await login();

    const invalidJson = await SELF.fetch(`${origin}/api/admin/uploads/sessions`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalidJson.status).toBe(400);

    const suppliedPartSize = await createSession(cookie, mounted, { partSize: 1 });
    expect(suppliedPartSize.status).toBe(400);
    expect((await suppliedPartSize.json() as { error: { code: string } }).error.code).toBe('UPLOAD_PART_INVALID');
    expect(driver.resumableUpload?.create).not.toHaveBeenCalled();
  });

  it('isolates upload sessions by authenticated administrator session', async () => {
    const mounted = await createUploadMount();
    driverRegistry.onedrive = () => fakeDriver();
    const ownerCookie = await login();
    const otherCookie = await login();
    const id = await sessionId(await createSession(ownerCookie, mounted));

    const hidden = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${id}`, {
      headers: { cookie: otherCookie },
    });
    expect(hidden.status).toBe(404);
    expect((await hidden.json() as { error: { code: string } }).error.code).toBe('UPLOAD_SESSION_NOT_FOUND');
  });

  it('requires same origin for every session mutation', async () => {
    const mounted = await createUploadMount();
    driverRegistry.onedrive = () => fakeDriver();
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));
    const attempts = [
      partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES, originHeader: 'https://attacker.example' }),
      new Request(`${origin}/api/admin/uploads/sessions/${id}/complete`, {
        method: 'POST', headers: { cookie, origin: 'https://attacker.example' },
      }),
      new Request(`${origin}/api/admin/uploads/sessions/${id}`, {
        method: 'DELETE', headers: { cookie, origin: 'https://attacker.example' },
      }),
    ];

    for (const request of attempts) {
      const response = await SELF.fetch(request);
      expect(response.status).toBe(403);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('ORIGIN_NOT_ALLOWED');
    }
  });

  it('requires an exact Content-Length and body for upload parts', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver();
    driverRegistry.onedrive = () => driver;
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));
    const missingLength = new Request(`${origin}/api/admin/uploads/sessions/${id}/parts/1`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'application/octet-stream' },
      body: 'x',
    });

    const missing = await SELF.fetch(missingLength);
    expect(missing.status).toBe(400);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('UPLOAD_PART_INVALID');

    const wrong = await SELF.fetch(partRequest(cookie, id, { length: 1 }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json() as { error: { code: string } }).error.code).toBe('UPLOAD_PART_INVALID');
    expect(driver.resumableUpload?.uploadPart).not.toHaveBeenCalled();
  });

  it('returns a recorded part for a matching duplicate without resending it upstream', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver();
    driverRegistry.onedrive = () => driver;
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));

    const first = await SELF.fetch(partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES }));
    const duplicate = await SELF.fetch(partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES }));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    await expect(responseData(duplicate)).resolves.toEqual({ partNumber: 1, size: UPLOAD_PART_SIZE_BYTES });
    expect(driver.resumableUpload?.uploadPart).toHaveBeenCalledTimes(1);
  });

  it('returns UPLOAD_PART_BUSY while another five-minute part claim is active', async () => {
    const mounted = await createUploadMount();
    driverRegistry.onedrive = () => fakeDriver();
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));
    const session = await currentAdminSession(workerEnv(), new Request(origin, { headers: { cookie } }));
    const now = Date.now();
    await claimUploadPart(workerEnv(), session!.id, id, 1, now + 5 * 60_000, now);

    const response = await SELF.fetch(partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES }));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('UPLOAD_PART_BUSY');
  });

  it('completes and cancels sessions idempotently', async () => {
    const mounted = await createUploadMount();
    const completeDriver = fakeDriver();
    driverRegistry.onedrive = () => completeDriver;
    const cookie = await login();
    const completedId = await sessionId(await createSession(cookie, mounted));
    expect((await SELF.fetch(partRequest(cookie, completedId, { length: UPLOAD_PART_SIZE_BYTES }))).status).toBe(200);

    const completed = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${completedId}/complete`, {
      method: 'POST', headers: { cookie, origin },
    });
    const repeated = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${completedId}/complete`, {
      method: 'POST', headers: { cookie, origin },
    });
    expect(completed.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await completed.json());
    expect(completeDriver.resumableUpload?.complete).toHaveBeenCalledTimes(1);

    const abortDriver = fakeDriver();
    driverRegistry.onedrive = () => abortDriver;
    const abortedId = await sessionId(await createSession(cookie, mounted));
    const aborted = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${abortedId}`, {
      method: 'DELETE', headers: { cookie, origin },
    });
    const abortedAgain = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${abortedId}`, {
      method: 'DELETE', headers: { cookie, origin },
    });
    expect(aborted.status).toBe(204);
    expect(abortedAgain.status).toBe(204);
    expect(abortDriver.resumableUpload?.abort).toHaveBeenCalledTimes(1);
  });

  it('returns a safe conflict and finalizes when DELETE follows a completed OneDrive part', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver();
    driverRegistry.onedrive = () => driver;
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));
    expect((await SELF.fetch(partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES }))).status).toBe(200);

    const response = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${id}`, {
      method: 'DELETE', headers: { cookie, origin },
    });

    expect(response.status).toBe(409);
    const responseText = await response.clone().text();
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: 'UPLOAD_ALREADY_COMPLETED', message: 'Upload has already completed' },
    });
    expect(responseText).not.toMatch(/providerState|uploadUrl|uploadId|integrityProof|private/);
    expect(driver.resumableUpload?.complete).toHaveBeenCalledTimes(1);
    expect(driver.resumableUpload?.abort).not.toHaveBeenCalled();
    await expect(workerEnv().DB.prepare('SELECT status FROM upload_sessions WHERE id = ?')
      .bind(id).first()).resolves.toEqual({ status: 'completed' });
  });

  it('returns UPLOAD_SESSION_EXPIRED for an expired active session', async () => {
    const mounted = await createUploadMount();
    driverRegistry.onedrive = () => fakeDriver();
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));
    await workerEnv().DB.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, id)
      .run();

    const response = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${id}`, { headers: { cookie } });
    expect(response.status).toBe(410);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('UPLOAD_SESSION_EXPIRED');
  });

  it('preserves provider-specific retryable codes and releases the failed part claim', async () => {
    const mounted = await createUploadMount();
    const driver = fakeDriver({
      uploadPart: vi.fn(async () => {
        throw new HttpError(
          503,
          'ONEDRIVE_UPLOAD_SESSION_RATE_LIMITED',
          'uploadUrl=https://upload.example/private uploadId=private proof=private',
          { retryAfter: '30', uploadUrl: 'https://upload.example/private', uploadId: 'private', proof: 'private' },
        );
      }),
    });
    driverRegistry.onedrive = () => driver;
    const cookie = await login();
    const id = await sessionId(await createSession(cookie, mounted));

    const response = await SELF.fetch(partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES }));
    expect(response.status).toBe(503);
    const responseText = await response.clone().text();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'ONEDRIVE_UPLOAD_SESSION_RATE_LIMITED',
        message: 'OneDrive upload session is temporarily rate limited',
        details: { retryAfter: 30 },
      },
    });
    expect(responseText).not.toMatch(/uploadUrl|uploadId|proof|private/);
    await expect(workerEnv().DB.prepare('SELECT active_part_number FROM upload_sessions WHERE id = ?')
      .bind(id).first()).resolves.toEqual({ active_part_number: null });
  });

  it('never exposes provider state, proofs, URLs, or upload IDs in successful JSON responses', async () => {
    const mounted = await createUploadMount();
    driverRegistry.onedrive = () => fakeDriver();
    const cookie = await login();
    const createResponse = await createSession(cookie, mounted);
    const createJson = await createResponse.clone().json();
    const id = (createJson as { data: { id: string } }).data.id;
    const getResponse = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${id}`, { headers: { cookie } });
    const partResponse = await SELF.fetch(partRequest(cookie, id, { length: UPLOAD_PART_SIZE_BYTES }));
    const completeResponse = await SELF.fetch(`${origin}/api/admin/uploads/sessions/${id}/complete`, {
      method: 'POST', headers: { cookie, origin },
    });
    const payloads = [createJson, await getResponse.json(), await partResponse.json(), await completeResponse.json()];

    for (const payload of payloads) expect(forbiddenResponseKeys(payload)).toEqual([]);
  });
});
