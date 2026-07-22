import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { routeRequest } from '../../src/worker/router';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
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

async function nativeTree(): Promise<{ folderId: string; fileId: string }> {
  const db = workerEnv().DB;
  await db.prepare('DELETE FROM shares').run();
  await db.prepare("UPDATE mounts SET enabled = 1 WHERE id = 'native-r2'").run();
  await db.prepare("DELETE FROM entries WHERE id = 'share-public-file'").run();
  await db.prepare("DELETE FROM entries WHERE id = 'share-public-folder'").run();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag, status,
    lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) VALUES ('share-public-folder', 'root', 'Shared folder', 'folder', NULL, 0, NULL, NULL, 'ready', NULL, 0, 0, '', ?, ?)`)
    .bind(now, now).run();
  await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag, status,
    lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) VALUES ('share-public-file', 'share-public-folder', 'private.txt', 'file', 'shares/public.txt', 12, 'text/plain', 'etag', 'ready', NULL, 0, 0, '', ?, ?)`)
    .bind(now, now).run();
  await workerEnv().R2_BUCKET.put('shares/public.txt', 'private-data', { httpMetadata: { contentType: 'text/plain' } });
  return { folderId: 'share-public-folder', fileId: 'share-public-file' };
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
  it('limits share passwords before verification and returns an integer Retry-After', async () => {
    const { fileId } = await nativeTree();
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
    const { fileId } = await nativeTree();
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
    const { fileId } = await nativeTree();
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
    const { fileId } = await nativeTree();
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

  it('upgrades only a successfully verified legacy share password hash', async () => {
    const { fileId } = await nativeTree();
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
    const upgraded = await workerEnv().DB.prepare('SELECT password_hash FROM shares WHERE id = ?')
      .bind(id).first<{ password_hash: string }>();
    expect(upgraded?.password_hash).toMatch(/^pbkdf2-sha256:600000:[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it('never rewrites a legacy share password hash after failed authentication', async () => {
    const { fileId } = await nativeTree();
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
    const { fileId } = await nativeTree();
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
    const { fileId } = await nativeTree();
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
        hashPassword: async () => 'pbkdf2-sha256:600000:00112233445566778899aabbccddeeff:'.concat('00'.repeat(32)),
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

  it('lists a private folder, previews with Range, and enforces direct download policy', async () => {
    const { folderId } = await nativeTree();
    const { token } = await createShare(folderId, { allowDownload: false });
    const listed = await SELF.fetch(`${origin}/s/${token}/api/list`);
    expect(listed.status).toBe(200);
    const directory = (await listed.json() as { data: { items: Array<{ id: string; name: string }> } }).data;
    expect(directory.items).toHaveLength(1);
    const item = directory.items[0];
    expect(item.id).not.toContain('share-public-file');

    const preview = await SELF.fetch(`${origin}/s/${token}/file/${encodeURIComponent(item.id)}/private.txt`, {
      headers: { range: 'bytes=0-6' },
    });
    expect(preview.status).toBe(206);
    await expect(preview.text()).resolves.toBe('private');

    const denied = await SELF.fetch(`${origin}/s/${token}/file/${encodeURIComponent(item.id)}/private.txt?download=1`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('private, no-store');
    expect(await denied.json()).toMatchObject({ error: { code: 'SHARE_DOWNLOAD_DISABLED' } });
  });

  it('applies disabled, expired, deleted, missing-target, and provider-unavailable state immediately', async () => {
    const { fileId } = await nativeTree();
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
    await workerEnv().DB.prepare("DELETE FROM entries WHERE id = 'share-public-file'").run();
    expect(await (await SELF.fetch(`${origin}/s/${missing.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_TARGET_MISSING' } });

    await nativeTree();
    const unavailable = await createShare(fileId);
    await workerEnv().DB.prepare("UPDATE mounts SET enabled = 0 WHERE id = 'native-r2'").run();
    expect(await (await SELF.fetch(`${origin}/s/${unavailable.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_PROVIDER_UNAVAILABLE' } });

    await workerEnv().DB.prepare('DELETE FROM shares WHERE id = ?').bind(unavailable.id).run();
    expect(await (await SELF.fetch(`${origin}/s/${unavailable.token}/api`)).json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
  });
});
