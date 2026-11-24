import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionIdFromToken } from '../../src/worker/auth';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { HttpError } from '../../src/worker/http';
import { createMount } from '../../src/worker/mounts';
import { routeRequest } from '../../src/worker/router';
import { createUploadSessionRecord } from '../../src/worker/upload-session-store';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const originalS3Factory = driverRegistry.s3;

function workerEnv(): Env {
  return env as unknown as Env;
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '127.0.0.1', 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function setupS3Fixture(isPublic = true) {
  const db = workerEnv().DB;
  await db.prepare('DELETE FROM upload_sessions').run();
  await db.prepare('DELETE FROM mounts').run();
  const mount = await createMount(db, {
    name: 'Cloud',
    mountPath: '/cloud',
    driverType: 's3',
    provider: 'custom',
    isPublic,
  });

  const items = new Map<string, StorageItem>([
    ['root', { id: 'root', parentId: null, name: 'Cloud', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null }],
  ]);
  const contents = new Map<string, { body: string; contentType: string }>();
  const abortSpy = vi.fn(async () => undefined);

  const driver: StorageDriver = {
    rootId: 'root',
    capabilities: new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'delete']),
    isWithin: vi.fn(async (itemId, ancestorId) => {
      let current = items.get(itemId);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (current.id === ancestorId) return true;
        if (!current.parentId) return false;
        seen.add(current.id);
        current = items.get(current.parentId);
      }
      return false;
    }),
    list: vi.fn(async (parentId) => ({
      items: [...items.values()].filter((candidate) => candidate.parentId === parentId),
      nextCursor: null,
    })),
    stat: vi.fn(async (itemId) => {
      const item = items.get(itemId);
      if (!item) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      return item;
    }),
    getDownload: vi.fn(async (itemId, request) => {
      const stored = contents.get(itemId);
      if (!stored) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      const bytes = new TextEncoder().encode(stored.body);
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
          return {
            kind: 'stream' as const,
            response: new Response(bytes.slice(start, end + 1), {
              status: 206,
              headers: {
                'accept-ranges': 'bytes',
                'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
                'content-length': String(end - start + 1),
                'content-type': stored.contentType,
              },
            }),
          };
        }
      }
      return {
        kind: 'stream' as const,
        response: new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength), 'content-type': stored.contentType },
        }),
      };
    }),
    createFolder: vi.fn(async (parentId, name) => {
      const id = `folder-${crypto.randomUUID()}`;
      const folder: StorageItem = { id, parentId, name, kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null };
      items.set(id, folder);
      return folder;
    }),
    upload: vi.fn(async (parentId, name, stream, contentType) => {
      const text = await new Response(stream).text();
      const id = `file-${name}`;
      const file: StorageItem = {
        id,
        parentId,
        name,
        kind: 'file',
        size: new TextEncoder().encode(text).byteLength,
        contentType,
        modifiedAt: null,
        etag: 'etag',
      };
      items.set(id, file);
      contents.set(id, { body: text, contentType });
      return file;
    }),
    rename: vi.fn(async (itemId, name) => {
      const item = items.get(itemId);
      if (!item) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      const updated = { ...item, name };
      items.set(itemId, updated);
      return updated;
    }),
    move: vi.fn(async (itemId, destinationParentId) => {
      const item = items.get(itemId);
      if (!item) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      const updated = { ...item, parentId: destinationParentId };
      items.set(itemId, updated);
      return updated;
    }),
    copy: vi.fn(async () => { throw new Error('not implemented'); }),
    remove: vi.fn(async (itemId) => {
      items.delete(itemId);
      contents.delete(itemId);
    }),
    resumableUpload: {
      create: vi.fn(async () => ({ state: { uploadId: 'u1' }, expiresAt: Date.now() + 60_000 })),
      uploadPart: vi.fn(async () => ({ part: { partNumber: 1, size: 1, etag: '"e1"' } })),
      complete: vi.fn(),
      abort: abortSpy,
    },
  };

  driverRegistry.s3 = () => driver;
  return {
    mount,
    driver,
    abortSpy,
    rootEntryId: encodeExternalId(mount.id, 'root'),
  };
}

afterEach(() => {
  driverRegistry.s3 = originalS3Factory;
});

describe('filesystem API', () => {
  it('serializes simultaneous login verification slots across rotating usernames before invoking the verifier', async () => {
    let releaseVerification!: () => void;
    let enteredVerification!: () => void;
    const release = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const entered = new Promise<void>((resolve) => { enteredVerification = resolve; });
    let verificationCalls = 0;
    const options = {
      passwordAuthentication: {
        now: () => 9_000,
        clientIp: '203.0.113.19',
        verifyPassword: async () => {
          verificationCalls += 1;
          enteredVerification();
          await release;
          return false;
        },
      },
    };
    const attempt = (username: string) => routeRequest(new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username, password: 'wrong-password' }),
    }), workerEnv(), options);

    const first = attempt('missing-0');
    await entered;
    const concurrent = await Promise.all(Array.from({ length: 11 }, (_, index) => attempt(`missing-${index + 1}`)));
    expect(verificationCalls).toBe(1);
    expect(concurrent.map((response) => response.status)).toEqual(Array(11).fill(429));
    for (const response of concurrent) {
      expect(response.headers.get('retry-after')).toBe('30');
      expect(Number.isInteger(Number(response.headers.get('retry-after')))).toBe(true);
    }

    releaseVerification();
    expect((await first).status).toBe(401);
    expect(verificationCalls).toBe(1);
  });

  it('verifies once for unknown usernames and blocks before password verification', async () => {
    let now = 10_000;
    let verificationCalls = 0;
    const options = {
      passwordAuthentication: {
        now: () => now,
        verifyPassword: async () => {
          verificationCalls += 1;
          return false;
        },
      },
    };
    const attempt = (username = 'missing-user') => routeRequest(new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.20',
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ username, password: 'wrong-password' }),
    }), workerEnv(), options);

    const unknown = await attempt();
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: { message: 'Invalid username or password' } });
    expect(verificationCalls).toBe(1);

    for (const delay of [1, 2, 4, 8]) {
      now += delay;
      const response = await attempt();
      expect(response.status).toBe(401);
    }
    expect(verificationCalls).toBe(5);

    now += 8;
    const throttled = await attempt();
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('37');
    expect(await throttled.json()).toMatchObject({ error: { code: 'AUTH_RATE_LIMITED' } });
    expect(verificationCalls).toBe(5);

    const wrongPassword = await routeRequest(new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.21',
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    }), workerEnv(), options);
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toMatchObject({ error: { message: 'Invalid username or password' } });
    expect(verificationCalls).toBe(6);
  });

  it('enforces a five-per-minute total administrator budget across distinct unknown usernames', async () => {
    let now = 10_500;
    let verificationCalls = 0;
    const options = {
      passwordAuthentication: {
        now: () => now,
        verifyPassword: async () => {
          verificationCalls += 1;
          return false;
        },
      },
    };
    const attempt = (username: string) => routeRequest(new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.25',
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ username, password: 'wrong-password' }),
    }), workerEnv(), options);

    for (const [index, delay] of [0, 1, 2, 4, 8].entries()) {
      now += delay;
      expect((await attempt(`missing-${index}`)).status).toBe(401);
    }
    expect(verificationCalls).toBe(5);
    const totalState = await workerEnv().DB.prepare(`SELECT failure_count FROM auth_rate_limits
      WHERE scope = 'admin-login-ip'`).first<{ failure_count: number }>();
    expect(totalState?.failure_count).toBe(5);

    const throttled = await attempt('missing-rotated-again');
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('45');
    expect(await throttled.json()).toMatchObject({ error: { code: 'AUTH_RATE_LIMITED' } });
    expect(verificationCalls).toBe(5);
  });

  it('clears the login limiter after successful authentication', async () => {
    let now = 11_000;
    let valid = false;
    let verificationCalls = 0;
    const options = {
      passwordAuthentication: {
        now: () => now,
        verifyPassword: async () => {
          verificationCalls += 1;
          return valid;
        },
      },
    };
    const attempt = () => routeRequest(new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.22',
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ username: 'admin', password: 'test-password' }),
    }), workerEnv(), options);

    expect((await attempt()).status).toBe(401);
    now += 1;
    valid = true;
    expect((await attempt()).status).toBe(200);
    const cleared = await workerEnv().DB.prepare(`SELECT scope FROM auth_rate_limits
      WHERE scope IN ('admin-login', 'admin-login-ip')`).all<{ scope: string }>();
    expect(cleared.results).toEqual([]);
    valid = false;
    expect((await attempt()).status).toBe(401);
    expect(verificationCalls).toBe(3);
  });

  it('warns without secret material after a legacy administrator hash succeeds', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await routeRequest(new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ username: 'admin', password: 'test-password' }),
    }), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.23',
        verifyPasswordDetailed: async () => ({ valid: true, needsUpgrade: true }),
      },
    });

    expect(response.status).toBe(200);
    expect(warning).toHaveBeenCalledOnce();
    const message = String(warning.mock.calls[0][0]);
    expect(message).toContain('rotate');
    expect(message).not.toContain('test-password');
    expect(message).not.toContain(workerEnv().ADMIN_PASSWORD_HASH);
  });

  it('releases the verification lease when the administrator verifier throws', async () => {
    const request = () => new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: 'admin', password: 'test-password' }),
    });
    const failed = await routeRequest(request(), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.24',
        verifyPasswordDetailed: async () => { throw new Error('verifier unavailable'); },
      },
    });
    expect(failed.status).toBe(500);

    const retry = await routeRequest(request(), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.24',
        verifyPassword: async () => false,
      },
    });
    expect(retry.status).toBe(401);
  });

  it('lists external mounts while stable file routes serve content', async () => {
    const cookie = await login();
    const { mount, rootEntryId } = await setupS3Fixture(true);
    const upload = await SELF.fetch(`${origin}/api/admin/files/task-compat?parentId=${encodeURIComponent(rootEntryId)}&name=compat.txt`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'text/plain' },
      body: 'external-s3-data',
    });
    expect(upload.status).toBe(200);
    const uploadedId = (await upload.json() as { data: { id: string } }).data.id;

    const guest = await SELF.fetch(`${origin}/api/fs/list?path=/`);
    expect(guest.status).toBe(200);
    expect(await guest.json()).toMatchObject({
      data: {
        items: [
          expect.objectContaining({ id: mount.id, name: 'Cloud', kind: 'folder', mountId: mount.id }),
        ],
      },
    });

    const mounted = await SELF.fetch(`${origin}/api/fs/list?path=/cloud`);
    expect(mounted.status).toBe(200);
    expect(await mounted.json()).toMatchObject({
      data: { items: expect.arrayContaining([expect.objectContaining({ id: uploadedId, name: 'compat.txt' })]) },
    });

    const admin = await SELF.fetch(`${origin}/api/fs/list?path=/`, { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect((await admin.json() as { data: { current: { capabilities: { rename: boolean } } } }).data.current.capabilities.rename).toBe(false);

    const stable = await SELF.fetch(`${origin}/file/${encodeURIComponent(uploadedId)}/ignored-name`);
    expect(stable.status).toBe(200);
    await expect(stable.text()).resolves.toBe('external-s3-data');
  });

  it('creates, renames, moves, deletes through admin routes, and rejects retired visibility route', async () => {
    const cookie = await login();
    const { rootEntryId } = await setupS3Fixture(true);
    const headers = { cookie, origin, 'content-type': 'application/json' };
    const created = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST', headers, body: JSON.stringify({ parentId: rootEntryId, name: 'Docs' }),
    });
    expect(created.status).toBe(200);
    const entry = (await created.json() as { data: { id: string } }).data;
    const renamed = await SELF.fetch(`${origin}/api/admin/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Documents' }),
    });
    expect(renamed.status).toBe(200);

    const visibility = await SELF.fetch(`${origin}/api/admin/entries/visibility`, {
      method: 'POST', headers, body: JSON.stringify({ ids: [entry.id], isPublic: false }),
    });
    expect(visibility.status).toBe(405);

    const removed = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers, body: JSON.stringify({ ids: [entry.id] }),
    });
    expect((await removed.json() as { data: { succeeded: string[] } }).data.succeeded).toEqual([entry.id]);
  });

  it('requires same-origin and authentication for mutations', async () => {
    const { rootEntryId } = await setupS3Fixture(true);
    const unauthenticated = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ parentId: rootEntryId, name: 'Docs' }),
    });
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json() as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');

    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ parentId: rootEntryId, name: 'Docs' }),
    });
    expect(response.status).toBe(403);
  });

  it('requires authentication for mount administration routes', async () => {
    const unauthenticated = await SELF.fetch(`${origin}/api/admin/mounts`);
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json() as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');

    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/mounts`, { headers: { cookie } });
    expect(response.status).toBe(200);
  });

  it('uploads and streams a stable entry URL with Range support', async () => {
    const cookie = await login();
    const { rootEntryId } = await setupS3Fixture(true);
    const upload = await SELF.fetch(`${origin}/api/admin/files/task-hello?parentId=${encodeURIComponent(rootEntryId)}&name=hello.txt`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(upload.status).toBe(200);
    const entryId = (await upload.json() as { data: { id: string } }).data.id;

    const response = await SELF.fetch(`${origin}/file/${encodeURIComponent(entryId)}/ignored-name`, { headers: { range: 'bytes=0-1' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/5');
    await expect(response.text()).resolves.toBe('he');
  });

  it.each([
    ['HTML', 'report.html', 'text/html; charset=utf-8', '<script>alert(1)</script>'],
    ['SVG', 'icon.svg', 'image/svg+xml', '<svg><script>alert(1)</script></svg>'],
  ])('isolates active external %s content without changing Range semantics', async (_label, name, contentType, body) => {
    const cookie = await login();
    const { rootEntryId } = await setupS3Fixture(true);
    const uploaded = await SELF.fetch(`${origin}/api/admin/files/task-active?parentId=${encodeURIComponent(rootEntryId)}&name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': contentType },
      body,
    });
    const entryId = (await uploaded.json() as { data: { id: string } }).data.id;

    const response = await SELF.fetch(`${origin}/file/${encodeURIComponent(entryId)}/${name}`, {
      headers: { range: 'bytes=0-7' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-7/${new TextEncoder().encode(body).byteLength}`);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.text()).resolves.toBe(body.slice(0, 8));
  });

  it('adds application security headers to APIs and Workers Assets', async () => {
    const api = await SELF.fetch(`${origin}/api/fs/list?path=/`);
    const asset = await SELF.fetch(`${origin}/`);

    for (const response of [api, asset]) {
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(response.headers.get('content-security-policy')).toContain("worker-src 'self'");
      expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    }
  });

  it('hides files on private mounts from guests while permitting administrators', async () => {
    const cookie = await login();
    const { rootEntryId } = await setupS3Fixture(false);
    const uploaded = await SELF.fetch(`${origin}/api/admin/files/task-private?parentId=${encodeURIComponent(rootEntryId)}&name=private.txt`, {
      method: 'PUT', headers: { cookie, origin, 'content-type': 'text/plain' }, body: 'private',
    });
    const entryId = (await uploaded.json() as { data: { id: string } }).data.id;

    const guest = await SELF.fetch(`${origin}/file/${encodeURIComponent(entryId)}/private.txt`);
    expect(guest.status).toBe(404);
    expect((await guest.json() as { error: { code: string } }).error.code).toBe('ENTRY_NOT_FOUND');

    const admin = await SELF.fetch(`${origin}/file/${encodeURIComponent(entryId)}/private.txt`, { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect(admin.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns structured errors for malformed IDs, percent-encoding, and arrays', async () => {
    const malformed = await SELF.fetch(`${origin}/api/fs/entries/bad%2Fid`);
    expect(malformed.status).toBe(404);
    expect((await malformed.json() as { error: { code: string } }).error.code).toBe('ENTRY_NOT_FOUND');

    const cookie = await login();
    const badPercentPatch = await SELF.fetch(`${origin}/api/admin/entries/bad%ZZ`, {
      method: 'PATCH',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x.txt' }),
    });
    expect(badPercentPatch.status).toBe(404);
    expect((await badPercentPatch.json() as { error: { code: string } }).error.code).toBe('ENTRY_NOT_FOUND');

    const invalid = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: 'nope' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('aborts active upload sessions before deleting the admin session on logout', async () => {
    const cookie = await login();
    const { mount, abortSpy } = await setupS3Fixture(false);
    const activeSessionId = await sessionIdFromToken(workerEnv(), cookie.slice('ilist_session='.length));

    await createUploadSessionRecord(workerEnv(), activeSessionId, {
      mountId: mount.id,
      parentItemId: 'root',
      name: 'pending.bin',
      size: 1024,
      contentType: 'application/octet-stream',
      partSize: 512,
      providerState: { uploadId: 'u1' },
      expiresAt: Date.now() + 60_000,
    });

    const logout = await SELF.fetch(`${origin}/api/admin/logout`, {
      method: 'POST',
      headers: { cookie, origin },
    });
    expect(logout.status).toBe(200);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    const remaining = await workerEnv().DB.prepare('SELECT COUNT(*) AS count FROM upload_sessions').first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it('supports cursor/limit pagination, guest edge list cache, ?refresh=1 bypass, and admin cache busting', async () => {
    const db = workerEnv().DB;
    await db.prepare('DELETE FROM mounts').run();
    const mount = await createMount(db, {
      name: 'Cached Cloud',
      mountPath: '/cached',
      driverType: 's3',
      provider: 'custom',
      isPublic: true,
    });
    const listMock = vi.fn(async (_parentId: string, cursor?: string, limit?: number) => ({
      items: [
        { id: cursor ?? 'page1', parentId: 'root', name: `file-${cursor ?? '1'}-${limit ?? 200}.txt`, kind: 'file' as const, size: 1, contentType: 'text/plain', modifiedAt: null, etag: null },
      ],
      nextCursor: cursor ? null : 'cursor-2',
    }));
    const createFolderMock = vi.fn(async () => ({
      id: 'new-folder', parentId: 'root', name: 'New', kind: 'folder' as const, size: null, contentType: null, modifiedAt: null, etag: null,
    }));
    driverRegistry.s3 = () => ({
      rootId: 'root',
      capabilities: new Set(['list', 'createFolder']),
      isWithin: async () => true,
      list: listMock,
      stat: async () => ({ id: 'root', parentId: null, name: 'Cached Cloud', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null }),
      getDownload: async () => { throw new HttpError(404, 'ENTRY_NOT_FOUND', 'missing'); },
      createFolder: createFolderMock,
      upload: async () => { throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'no'); },
      rename: async () => { throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'no'); },
      move: async () => { throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'no'); },
      copy: async () => { throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'no'); },
      remove: async () => undefined,
    });

    const first = await SELF.fetch(`${origin}/api/fs/list?path=/cached&limit=5`);
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as { data: { nextCursor: string | null; items: Array<{ name: string }> } };
    expect(firstPayload.data.nextCursor).toBe('cursor-2');
    expect(firstPayload.data.items[0]!.name).toBe('file-1-5.txt');

    const second = await SELF.fetch(`${origin}/api/fs/list?path=/cached&limit=5`);
    expect(second.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);

    const bypassed = await SELF.fetch(`${origin}/api/fs/list?path=/cached&limit=5&refresh=1`);
    expect(bypassed.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(2);

    const paged = await SELF.fetch(`${origin}/api/fs/list?path=/cached&cursor=cursor-2&limit=5`);
    expect(paged.status).toBe(200);
    const pagedPayload = await paged.json() as { data: { nextCursor: string | null; items: Array<{ name: string }> } };
    expect(pagedPayload.data.nextCursor).toBeNull();
    expect(pagedPayload.data.items[0]!.name).toBe('file-cursor-2-5.txt');
    expect(listMock).toHaveBeenCalledTimes(3);

    const cookie = await login();
    const createdFolder = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: encodeExternalId(mount.id, 'root'), name: 'New' }),
    });
    expect(createdFolder.status).toBe(200);

    const afterMutation = await SELF.fetch(`${origin}/api/fs/list?path=/cached&limit=5`);
    expect(afterMutation.status).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(4);
  });

  it('cleans expired sessions, oauth states, rate limits, and uploads in scheduled handler', async () => {
    const db = workerEnv().DB;
    const { mount, abortSpy } = await setupS3Fixture(false);
    const nowSec = Math.floor(Date.now() / 1000);
    const activeSessId = 'active-sess';
    await db.prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)')
      .bind(activeSessId, nowSec + 600, nowSec)
      .run();
    await db.prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)')
      .bind('expired-sess', nowSec - 60, nowSec - 120)
      .run();
    await db.prepare('INSERT INTO oauth_states (state_hash, mount_id, verifier_ciphertext, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('expired-oauth-hash', mount.id, 'verifier', Date.now() - 60_000, new Date().toISOString())
      .run();
    await db.prepare(
      `INSERT INTO auth_rate_limits (
        key_hash, scope, window_started_at, failure_count, blocked_until,
        reservation_token, reservation_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('old-rl', 'admin-login', nowSec - 48 * 60 * 60, 1, 0, null, 0, nowSec - 48 * 60 * 60)
      .run();
    const expiredUpload = await createUploadSessionRecord(workerEnv(), activeSessId, {
      mountId: mount.id,
      parentItemId: 'root',
      name: 'expired.bin',
      size: 1024,
      contentType: 'application/octet-stream',
      partSize: 512,
      providerState: { uploadId: 'u-expired' },
      expiresAt: Date.now() - 10_000,
    });

    const workerModule = (await import('../../src/worker/index')).default;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext;
    await workerModule.scheduled({} as ScheduledController, workerEnv(), ctx);
    await Promise.all(pending);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    await expect(db.prepare('SELECT id FROM sessions WHERE id = ?').bind('expired-sess').first()).resolves.toBeNull();
    await expect(db.prepare('SELECT state_hash FROM oauth_states WHERE state_hash = ?').bind('expired-oauth-hash').first()).resolves.toBeNull();
    await expect(db.prepare('SELECT key_hash FROM auth_rate_limits WHERE key_hash = ?').bind('old-rl').first()).resolves.toBeNull();
    await expect(db.prepare('SELECT status FROM upload_sessions WHERE id = ?').bind(expiredUpload.id).first()).resolves.toEqual({ status: 'aborted' });
  });
});
