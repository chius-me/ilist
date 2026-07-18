import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';

function workerEnv(): Env {
  return env as unknown as Env;
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
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
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: 'SHARE_PASSWORD_INVALID' } });

    const unlocked = await SELF.fetch(`${origin}/s/${token}/auth`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'share-password' }),
    });
    expect(unlocked.status).toBe(200);
    const setCookie = unlocked.headers.get('set-cookie')!;
    expect(setCookie).toContain(`Path=/s/${token}`);
    const authorized = await SELF.fetch(`${origin}/s/${token}/api`, { headers: { cookie: setCookie.split(';')[0] } });
    expect(authorized.status).toBe(200);
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
