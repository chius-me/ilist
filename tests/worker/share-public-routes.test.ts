import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverRegistry } from '../../src/worker/drivers/registry';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { encodeExternalId } from '../../src/worker/external-identity';
import { HttpError } from '../../src/worker/http';
import { createMount } from '../../src/worker/mounts';
import { routeRequest } from '../../src/worker/router';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const originalS3Factory = driverRegistry.s3;
const LEGACY_SHARE_PASSWORD_HASH =
  'pbkdf2:100000:00112233445566778899aabbccddeeff:b6969f61fc76d6202a99f47012dcd5b041024c4bbaa2c79a2f63e9a8e88bc4d8';

function workerEnv(): Env {
  return env as unknown as Env;
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: { 'CF-Connecting-IP': '127.0.0.1', origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  return response.headers.get('set-cookie')!.split(';')[0];
}

interface TreeControl {
  mountId: string;
  folderId: string;
  fileId: string;
  statCalls: number;
  isWithinCalls: number;
  setFile: (patch: { name?: string; contentType?: string | null; body?: string }) => void;
  deleteFile: () => void;
  setDownloadFailure: (failure: (() => Response | Promise<Response>) | null) => void;
}

async function s3Tree(): Promise<TreeControl> {
  const db = workerEnv().DB;
  await db.prepare('DELETE FROM shares').run();
  await db.prepare('DELETE FROM mounts').run();
  const mount = await createMount(db, {
    name: 'Share Cloud',
    mountPath: `/share-cloud-${crypto.randomUUID().slice(0, 8)}`,
    driverType: 's3',
    provider: 'custom',
    isPublic: false,
  });

  const bodies = new Map<string, string>([['share-public-file', 'private-data']]);
  const items = new Map<string, StorageItem>([
    ['root', { id: 'root', parentId: null, name: 'Root', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null }],
    ['share-public-folder', { id: 'share-public-folder', parentId: 'root', name: 'Shared folder', kind: 'folder', size: null, contentType: null, modifiedAt: null, etag: null }],
    ['share-public-file', { id: 'share-public-file', parentId: 'share-public-folder', name: 'private.txt', kind: 'file', size: 12, contentType: 'text/plain', modifiedAt: null, etag: 'etag' }],
  ]);

  let customDownload: (() => Response | Promise<Response>) | null = null;
  const control: TreeControl = {
    mountId: mount.id,
    folderId: encodeExternalId(mount.id, 'share-public-folder'),
    fileId: encodeExternalId(mount.id, 'share-public-file'),
    statCalls: 0,
    isWithinCalls: 0,
    setFile(patch) {
      const current = items.get('share-public-file');
      if (!current) return;
      const nextBody = patch.body ?? bodies.get('share-public-file') ?? '';
      bodies.set('share-public-file', nextBody);
      items.set('share-public-file', {
        ...current,
        name: patch.name ?? current.name,
        contentType: patch.contentType !== undefined ? patch.contentType : current.contentType,
        size: new TextEncoder().encode(nextBody).byteLength,
      });
    },
    deleteFile() {
      items.delete('share-public-file');
      bodies.delete('share-public-file');
    },
    setDownloadFailure(failure) {
      customDownload = failure;
    },
  };

  const driver: StorageDriver = {
    rootId: 'root',
    capabilities: new Set(['list', 'download']),
    isWithin: vi.fn(async (itemId: string, ancestorId: string) => {
      control.isWithinCalls += 1;
      const item = items.get(itemId);
      if (!item || !items.has(ancestorId)) return false;
      return itemId === ancestorId || item.parentId === ancestorId;
    }),
    list: vi.fn(async (parentId: string) => ({
      items: [...items.values()].filter((candidate) => candidate.parentId === parentId),
      nextCursor: null,
    })),
    stat: vi.fn(async (itemId: string) => {
      control.statCalls += 1;
      const item = items.get(itemId);
      if (!item) throw new HttpError(404, 'NOT_FOUND', 'Missing');
      return item;
    }),
    getDownload: vi.fn(async (itemId: string, request: Request) => {
      if (customDownload) {
        return { kind: 'stream' as const, response: await customDownload() };
      }
      const item = items.get(itemId);
      const body = bodies.get(itemId);
      if (!item || body === undefined) throw new HttpError(404, 'NOT_FOUND', 'Missing');
      const bytes = new TextEncoder().encode(body);
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
                'content-type': item.contentType ?? 'application/octet-stream',
              },
            }),
          };
        }
      }
      return {
        kind: 'stream' as const,
        response: new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.byteLength),
            'content-type': item.contentType ?? 'application/octet-stream',
          },
        }),
      };
    }),
    createFolder: vi.fn(),
    upload: vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
    copy: vi.fn(async () => { throw new Error('not implemented'); }),
  };

  driverRegistry.s3 = () => driver;
  return control;
}

async function createShare(entryId: string, policy: Record<string, unknown> = {}): Promise<{ token: string; id: string }> {
  const cookie = await login();
  const response = await SELF.fetch(`${origin}/api/admin/shares`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ entryId, allowDownload: false, ...policy }),
  });
  expect(response.status).toBe(200);
  const payload = await response.json() as { data: { url: string; share: { id: string } } };
  return { token: payload.data.url.split('/').at(-1)!, id: payload.data.share.id };
}

describe('public share routes', () => {
  afterEach(() => {
    driverRegistry.s3 = originalS3Factory;
  });

  it('limits share passwords before verification and returns an integer Retry-After', async () => {
    const { fileId } = await s3Tree();
    const { token } = await createShare(fileId, { password: 'share-password' });
    let now = 20_000;
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
    const attempt = () => routeRequest(new Request(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.30',
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ password: 'wrong-password' }),
    }), workerEnv(), options);

    for (let index = 0; index < 10; index += 1) {
      const response = await attempt();
      expect(response.status).toBe(401);
      if (index < 9) now += Math.min(2 ** index, 8);
    }
    expect(verificationCalls).toBe(10);

    const throttled = await attempt();
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('8');
    expect(await throttled.json()).toMatchObject({ error: { code: 'AUTH_RATE_LIMITED' } });
    expect(verificationCalls).toBe(10);
  });

  it('records malformed and oversized share passwords without verifying them', async () => {
    const { fileId } = await s3Tree();
    const { token } = await createShare(fileId, { password: 'share-password' });
    let verificationCalls = 0;
    const options = {
      passwordAuthentication: {
        now: () => 21_000,
        verifyPassword: async () => {
          verificationCalls += 1;
          return false;
        },
      },
    };
    const authenticate = (ip: string, body: string) => routeRequest(new Request(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip, 'content-type': 'application/json', origin },
      body,
    }), workerEnv(), options);

    const malformed = await authenticate('203.0.113.31', JSON.stringify({ password: 123 }));
    expect(malformed.status).toBe(401);
    expect((await authenticate('203.0.113.31', JSON.stringify({ password: 'not-reached' }))).status).toBe(429);

    const invalidJson = await authenticate('203.0.113.32', '{');
    expect(invalidJson.status).toBe(401);
    expect((await authenticate('203.0.113.32', JSON.stringify({ password: 'not-reached' }))).status).toBe(429);

    const oversized = await authenticate('203.0.113.33', JSON.stringify({ password: '密'.repeat(86) }));
    expect(oversized.status).toBe(401);
    expect((await authenticate('203.0.113.33', JSON.stringify({ password: 'not-reached' }))).status).toBe(429);
    expect(verificationCalls).toBe(0);
  });

  it('returns metadata for a private file without exposing its storage identity', async () => {
    const { fileId } = await s3Tree();
    const { token } = await createShare(fileId, { allowDownload: true });
    const response = await SELF.fetch(`${origin}/s/${token}/api`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.parse(text)).toMatchObject({ data: {
      name: 'private.txt', targetKind: 'file', allowDownload: true,
      entry: { name: 'private.txt', kind: 'file', capabilities: { preview: true, download: true } },
    } });
    expect(text).not.toMatch(/share-public-file|native-r2|shares\/public/);
  });

  it('requires the correct password and scopes authorization to one share path', async () => {
    const { fileId } = await s3Tree();
    const { token } = await createShare(fileId, { password: 'share-password' });
    const blocked = await SELF.fetch(`${origin}/s/${token}/api`);
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toMatchObject({ error: { code: 'SHARE_PASSWORD_REQUIRED' } });

    const wrong = await SELF.fetch(`${origin}/s/${token}/auth`, {
      method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.40', origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: 'SHARE_PASSWORD_INVALID' } });

    const unlocked = await SELF.fetch(`${origin}/s/${token}/auth`, {
      method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.41', origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'share-password' }),
    });
    expect(unlocked.status).toBe(200);
    const setCookie = unlocked.headers.get('set-cookie')!;
    expect(setCookie).toContain(`Path=/s/${token}`);
    const authorized = await SELF.fetch(`${origin}/s/${token}/api`, { headers: { cookie: setCookie.split(';')[0] } });
    expect(authorized.status).toBe(200);
  });

  it('revokes existing share authorization when the password changes', async () => {
    const { fileId } = await s3Tree();
    const { token, id } = await createShare(fileId, { password: 'old-password' });
    const unlocked = await SELF.fetch(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.45', origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'old-password' }),
    });
    expect(unlocked.status).toBe(200);
    const oldCookie = unlocked.headers.get('set-cookie')!.split(';')[0];
    expect((await SELF.fetch(`${origin}/s/${token}/api`, { headers: { cookie: oldCookie } })).status).toBe(200);

    const adminCookie = await login();
    const updated = await SELF.fetch(`${origin}/api/admin/shares/${id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-password' }),
    });
    expect(updated.status).toBe(200);

    const revoked = await SELF.fetch(`${origin}/s/${token}/api`, { headers: { cookie: oldCookie } });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: 'SHARE_PASSWORD_REQUIRED' } });

    const renewed = await SELF.fetch(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.46', origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-password' }),
    });
    expect(renewed.status).toBe(200);
  });

  it('upgrades only a successfully verified legacy share password hash', async () => {
    const { fileId } = await s3Tree();
    const { token, id } = await createShare(fileId, { password: 'temporary-password' });
    await workerEnv().DB.prepare('UPDATE shares SET password_hash = ? WHERE id = ?')
      .bind(LEGACY_SHARE_PASSWORD_HASH, id).run();

    let verifiedHash = '';
    const unlocked = await routeRequest(new Request(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.42', origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'share-password' }),
    }), workerEnv(), {
      passwordAuthentication: {
        verifyPasswordDetailed: async (_password, storedHash) => {
          verifiedHash = storedHash;
          return { valid: true, needsUpgrade: true };
        },
      },
    });

    expect(unlocked.status).toBe(200);
    expect(verifiedHash).toBe(LEGACY_SHARE_PASSWORD_HASH);
    const upgraded = await workerEnv().DB.prepare('SELECT password_hash, auth_revision FROM shares WHERE id = ?')
      .bind(id).first<{ password_hash: string; auth_revision: number }>();
    expect(upgraded?.password_hash).toMatch(/^pbkdf2-sha256:100000:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(upgraded?.auth_revision).toBe(1);
  });

  it('never rewrites a legacy share password hash after failed authentication', async () => {
    const { fileId } = await s3Tree();
    const { token, id } = await createShare(fileId, { password: 'temporary-password' });
    await workerEnv().DB.prepare('UPDATE shares SET password_hash = ? WHERE id = ?')
      .bind(LEGACY_SHARE_PASSWORD_HASH, id).run();

    const denied = await SELF.fetch(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.43', origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });

    expect(denied.status).toBe(401);
    const unchanged = await workerEnv().DB.prepare('SELECT password_hash FROM shares WHERE id = ?')
      .bind(id).first<{ password_hash: string }>();
    expect(unchanged?.password_hash).toBe(LEGACY_SHARE_PASSWORD_HASH);
  });

  it('releases the verification lease when a legacy share rehash throws', async () => {
    const { fileId } = await s3Tree();
    const { token, id } = await createShare(fileId, { password: 'temporary-password' });
    await workerEnv().DB.prepare('UPDATE shares SET password_hash = ? WHERE id = ?')
      .bind(LEGACY_SHARE_PASSWORD_HASH, id).run();
    const request = () => new Request(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'share-password' }),
    });

    const failed = await routeRequest(request(), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.44',
        verifyPasswordDetailed: async () => ({ valid: true, needsUpgrade: true }),
        hashPassword: async () => { throw new Error('crypto unavailable'); },
      },
    });
    expect(failed.status).toBe(500);

    const retry = await routeRequest(request(), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.44',
        verifyPassword: async () => false,
      },
    });
    expect(retry.status).toBe(401);
    const unchanged = await workerEnv().DB.prepare('SELECT password_hash FROM shares WHERE id = ?')
      .bind(id).first<{ password_hash: string }>();
    expect(unchanged?.password_hash).toBe(LEGACY_SHARE_PASSWORD_HASH);
  });

  it('releases the verification lease when the legacy share hash CAS throws', async () => {
    const { fileId } = await s3Tree();
    const { token, id } = await createShare(fileId, { password: 'temporary-password' });
    await workerEnv().DB.prepare('UPDATE shares SET password_hash = ? WHERE id = ?')
      .bind(LEGACY_SHARE_PASSWORD_HASH, id).run();
    const request = () => new Request(`${origin}/s/${token}/auth`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'share-password' }),
    });

    const failed = await routeRequest(request(), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.45',
        verifyPasswordDetailed: async () => ({ valid: true, needsUpgrade: true }),
        hashPassword: async () => 'pbkdf2-sha256:100000:00112233445566778899aabbccddeeff:'.concat('00'.repeat(32)),
        upgradeSharePasswordHash: async () => { throw new Error('D1 unavailable'); },
      },
    });
    expect(failed.status).toBe(500);

    const retry = await routeRequest(request(), workerEnv(), {
      passwordAuthentication: {
        clientIp: '203.0.113.45',
        verifyPassword: async () => false,
      },
    });
    expect(retry.status).toBe(401);
  });

  it('lists a private folder, previews safe text with Range, and enforces strict preview/download policy', async () => {
    const tree = await s3Tree();
    const { token } = await createShare(tree.folderId, { allowDownload: false });
    const listed = await SELF.fetch(`${origin}/s/${token}/api/list`);
    expect(listed.status).toBe(200);
    const directory = (await listed.json() as { data: { items: Array<{ id: string; name: string; capabilities: Record<string, boolean> }> } }).data;
    expect(directory.items).toHaveLength(1);
    const item = directory.items[0]!;
    expect(item.id).not.toContain('share-public-file');
    expect(item.capabilities.download).toBe(false);

    tree.statCalls = 0;
    const preview = await SELF.fetch(`${origin}/s/${token}/file/${encodeURIComponent(item.id)}/private.txt`, {
      headers: { range: 'bytes=0-6' },
    });
    expect(preview.status).toBe(206);
    expect(tree.statCalls).toBe(1);
    await expect(preview.text()).resolves.toBe('private');

    const denied = await SELF.fetch(`${origin}/s/${token}/file/${encodeURIComponent(item.id)}/private.txt?download=1`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('private, no-store');
    expect(await denied.json()).toMatchObject({ error: { code: 'SHARE_DOWNLOAD_DISABLED' } });
  });

  it.each([
    ['HTML', 'unsafe.html', 'text/html', '<script>alert(1)</script>'],
    ['SVG', 'unsafe.svg', 'image/svg+xml', '<svg><script>alert(1)</script></svg>'],
    ['binary archive', 'archive.zip', 'application/zip', 'PK\x03\x04test'],
  ])('blocks non-previewable %s when downloads are disabled and isolates it when downloads are allowed', async (_label, name, contentType, body) => {
    const tree = await s3Tree();
    tree.setFile({ name, contentType, body });

    const { token: lockedToken } = await createShare(tree.folderId, { allowDownload: false });
    const lockedList = await SELF.fetch(`${origin}/s/${lockedToken}/api/list`);
    const lockedItem = (await lockedList.json() as { data: { items: Array<{ id: string }> } }).data.items[0]!;
    const blocked = await SELF.fetch(`${origin}/s/${lockedToken}/file/${encodeURIComponent(lockedItem.id)}/${encodeURIComponent(name)}`);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: 'SHARE_DOWNLOAD_DISABLED' } });

    const { token: openToken } = await createShare(tree.folderId, { allowDownload: true });
    const openList = await SELF.fetch(`${origin}/s/${openToken}/api/list`);
    const openItem = (await openList.json() as { data: { items: Array<{ id: string }> } }).data.items[0]!;
    const response = await SELF.fetch(`${origin}/s/${openToken}/file/${encodeURIComponent(openItem.id)}/${encodeURIComponent(name)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe(body);
  });

  it('counts maxDownloads once on full/byte-0 GETs, ignores continuation ranges, and refunds upstream errors', async () => {
    const tree = await s3Tree();
    tree.setFile({ name: 'bundle.bin', contentType: 'application/octet-stream', body: '0123456789abcdef' });
    const { token } = await createShare(tree.folderId, { allowDownload: true, maxDownloads: 1 });
    const listed = await SELF.fetch(`${origin}/s/${token}/api/list`);
    const item = (await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0]!;
    const fileUrl = `${origin}/s/${token}/file/${encodeURIComponent(item.id)}/bundle.bin`;

    tree.setDownloadFailure(() => {
      throw new HttpError(502, 'UPSTREAM_ERROR', 'upstream failed');
    });
    const failed = await SELF.fetch(fileUrl);
    expect(failed.status).toBe(503);

    tree.setDownloadFailure(null);
    tree.statCalls = 0;
    const firstChunk = await SELF.fetch(fileUrl, { headers: { range: 'bytes=0-4' } });
    expect(firstChunk.status).toBe(206);
    expect(tree.statCalls).toBe(1);
    await expect(firstChunk.text()).resolves.toBe('01234');

    const continuation = await SELF.fetch(fileUrl, { headers: { range: 'bytes=5-9' } });
    expect(continuation.status).toBe(206);
    await expect(continuation.text()).resolves.toBe('56789');

    const exhaustedMeta = await (await SELF.fetch(`${origin}/s/${token}/api/list`)).json() as {
      data: { items: Array<{ capabilities: { download: boolean } }> };
    };
    expect(exhaustedMeta.data.items[0]?.capabilities.download).toBe(false);

    const limited = await SELF.fetch(fileUrl);
    expect(limited.status).toBe(403);
    expect(await limited.json()).toMatchObject({ error: { code: 'SHARE_DOWNLOAD_LIMIT' } });
  });

  it('applies disabled, expired, deleted, missing-target, and provider-unavailable state immediately', async () => {
    const tree = await s3Tree();
    const { fileId } = tree;
    const cookie = await login();
    const disabled = await createShare(fileId);
    await SELF.fetch(`${origin}/api/admin/shares/${disabled.id}`, {
      method: 'PATCH', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(await (await SELF.fetch(`${origin}/s/${disabled.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_DISABLED' } });

    await workerEnv().DB.prepare('DELETE FROM shares').run();
    const expired = await createShare(fileId, { expiresAt: '2099-01-01T00:00:00.000Z' });
    await workerEnv().DB.prepare('UPDATE shares SET expires_at = 1 WHERE id = ?').bind(expired.id).run();
    expect(await (await SELF.fetch(`${origin}/s/${expired.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_EXPIRED' } });

    await workerEnv().DB.prepare('DELETE FROM shares').run();
    const missing = await createShare(fileId);
    tree.deleteFile();
    expect(await (await SELF.fetch(`${origin}/s/${missing.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_TARGET_MISSING' } });

    const unavailableTree = await s3Tree();
    const unavailable = await createShare(unavailableTree.fileId);
    await workerEnv().DB.prepare('UPDATE mounts SET enabled = 0 WHERE id = ?').bind(unavailableTree.mountId).run();
    expect(await (await SELF.fetch(`${origin}/s/${unavailable.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_PROVIDER_UNAVAILABLE' } });

    await workerEnv().DB.prepare('DELETE FROM shares WHERE id = ?').bind(unavailable.id).run();
    expect(await (await SELF.fetch(`${origin}/s/${unavailable.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
  });
});
