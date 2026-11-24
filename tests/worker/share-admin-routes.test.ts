import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { createMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const originalS3Factory = driverRegistry.s3;

function workerEnv(): Env {
  return env as unknown as Env;
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '127.0.0.1', origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

function fakePrivateDriver(itemId: string): StorageDriver {
  const item: StorageItem = {
    id: itemId,
    parentId: 'root',
    name: 'secret.txt',
    kind: 'file',
    size: 6,
    contentType: 'text/plain',
    modifiedAt: null,
    etag: 'etag',
  };
  return {
    rootId: 'root',
    capabilities: new Set(['list', 'download']),
    isWithin: vi.fn(async (candidateId, ancestorId) => candidateId === ancestorId || candidateId === itemId),
    list: vi.fn(async () => ({ items: [item], nextCursor: null })),
    stat: vi.fn(async (id: string) => {
      if (id === 'root') {
        return { id: 'root', parentId: null, name: 'Root', kind: 'folder' as const, size: null, contentType: null, modifiedAt: null, etag: null };
      }
      if (id === itemId) return item;
      throw new Error('missing');
    }),
    getDownload: vi.fn(async () => ({ kind: 'stream' as const, response: new Response('secret', { headers: { 'content-type': 'text/plain' } }) })),
    createFolder: vi.fn(),
    upload: vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
    copy: vi.fn(async () => {
      throw new Error('not implemented');
    }),
  };
}

async function privateFile(itemId = `secret-${crypto.randomUUID()}.txt`): Promise<string> {
  await workerEnv().DB.prepare('DELETE FROM shares').run();
  await workerEnv().DB.prepare('DELETE FROM mounts').run();
  const mount = await createMount(workerEnv().DB, {
    name: 'Private Cloud',
    mountPath: `/private-cloud-${crypto.randomUUID().slice(0, 8)}`,
    driverType: 's3',
    provider: 'custom',
    isPublic: false,
  });
  driverRegistry.s3 = () => fakePrivateDriver(itemId);
  return encodeExternalId(mount.id, itemId);
}

async function createShare(cookie: string, entryId: string, overrides: Record<string, unknown> = {}) {
  return SELF.fetch(`${origin}/api/admin/shares`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ entryId, allowDownload: false, ...overrides }),
  });
}

describe('share administration routes', () => {
  afterEach(() => {
    driverRegistry.s3 = originalS3Factory;
  });

  it('requires authentication and same-origin mutations', async () => {
    const entryId = await privateFile();
    const unauthenticated = await createShare('', entryId);
    expect(unauthenticated.status).toBe(401);

    const cookie = await login();
    const crossOrigin = await SELF.fetch(`${origin}/api/admin/shares`, {
      method: 'POST',
      headers: { cookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ entryId, allowDownload: true }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('creates a private target share and returns its raw URL only once', async () => {
    const cookie = await login();
    const entryId = await privateFile();
    const response = await createShare(cookie, entryId, {
      password: 'share-password',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    expect(response.status).toBe(200);
    const created = await response.json() as { data: { url: string; share: Record<string, unknown> } };
    expect(created.data.url).toMatch(/^https:\/\/ilist\.example\/s\/[A-Za-z0-9_-]{43}$/);
    expect(created.data.share).toMatchObject({
      name: 'secret.txt', targetKind: 'file', mountName: 'Private Cloud',
      protected: true, expiresAt: '2099-01-01T00:00:00.000Z', allowDownload: false, enabled: true,
    });
    expect(JSON.stringify(created.data.share)).not.toMatch(/tokenHash|passwordHash|providerItemId|secret-/);

    const listed = await SELF.fetch(`${origin}/api/admin/shares`, { headers: { cookie } });
    const text = await listed.text();
    expect(listed.status).toBe(200);
    expect(text).not.toContain(created.data.url.split('/').at(-1)!);
    expect(text).not.toMatch(/tokenHash|passwordHash|providerItemId/);
  });

  it('updates policy without rotating hidden target data, then deletes immediately', async () => {
    const cookie = await login();
    const entryId = await privateFile();
    const createdResponse = await createShare(cookie, entryId, { allowDownload: true });
    const created = (await createdResponse.json() as { data: { share: { id: string } } }).data.share;

    const patched = await SELF.fetch(`${origin}/api/admin/shares/${created.id}`, {
      method: 'PATCH',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-password', expiresAt: '2099-02-01T00:00:00.000Z', allowDownload: false, enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ data: {
      id: created.id, protected: true, expiresAt: '2099-02-01T00:00:00.000Z', allowDownload: false, enabled: false,
    } });

    const cleared = await SELF.fetch(`${origin}/api/admin/shares/${created.id}`, {
      method: 'PATCH',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ clearPassword: true, expiresAt: null, enabled: true }),
    });
    expect(await cleared.json()).toMatchObject({ data: { protected: false, expiresAt: null, enabled: true } });

    const removed = await SELF.fetch(`${origin}/api/admin/shares/${created.id}`, {
      method: 'DELETE', headers: { cookie, origin },
    });
    expect(removed.status).toBe(204);
    const listed = await SELF.fetch(`${origin}/api/admin/shares`, { headers: { cookie } });
    expect(await listed.json()).toMatchObject({ data: [] });
  });

  it('rejects weak passwords, past expiration, unknown fields, and missing targets', async () => {
    const cookie = await login();
    const entryId = await privateFile();
    for (const [body, status] of [
      [{ entryId, allowDownload: true, password: 'short' }, 400],
      [{ entryId, allowDownload: true, expiresAt: '2020-01-01T00:00:00.000Z' }, 400],
      [{ entryId, allowDownload: true, providerItemId: 'leak' }, 400],
      [{ entryId: 'missing-target', allowDownload: true }, 404],
    ] as const) {
      const response = await SELF.fetch(`${origin}/api/admin/shares`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
    }
  });
});
