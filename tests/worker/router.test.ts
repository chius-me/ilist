import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

describe('filesystem API', () => {
  it('uses one list endpoint for guest and admin capabilities', async () => {
    const guest = await SELF.fetch(`${origin}/api/fs/list?path=/`);
    expect(guest.status).toBe(200);
    const cookie = await login();
    const admin = await SELF.fetch(`${origin}/api/fs/list?path=/`, { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect((await admin.json() as { data: { current: { capabilities: { rename: boolean } } } }).data.current.capabilities.rename).toBe(false);
  });

  it('creates, renames, moves, changes visibility, and deletes through admin routes', async () => {
    const cookie = await login();
    const headers = { cookie, origin, 'content-type': 'application/json' };
    const created = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST', headers, body: JSON.stringify({ parentId: 'root', name: 'Docs' }),
    });
    expect(created.status).toBe(200);
    const entry = (await created.json() as { data: { id: string } }).data;
    const renamed = await SELF.fetch(`${origin}/api/admin/entries/${entry.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Documents' }),
    });
    expect(renamed.status).toBe(200);
    const removed = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers, body: JSON.stringify({ ids: [entry.id] }),
    });
    expect((await removed.json() as { data: { succeeded: string[] } }).data.succeeded).toEqual([entry.id]);
  });

  it('requires same-origin and authentication for mutations', async () => {
    const unauthenticated = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ parentId: 'root', name: 'Docs' }),
    });
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json() as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');

    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ parentId: 'root', name: 'Docs' }),
    });
    expect(response.status).toBe(403);
  });

  it('uploads and streams a stable entry URL with Range support', async () => {
    const cookie = await login();
    const id = 'file-router-test';
    const upload = await SELF.fetch(`${origin}/api/admin/files/${id}?parentId=root&name=hello.txt`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(upload.status).toBe(200);

    const response = await SELF.fetch(`${origin}/file/${id}/ignored-name`, { headers: { range: 'bytes=0-1' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/5');
    await expect(response.text()).resolves.toBe('he');
  });

  it('hides private files from guests while permitting administrators', async () => {
    const cookie = await login();
    const id = 'file-private-test';
    await SELF.fetch(`${origin}/api/admin/files/${id}?parentId=root&name=private.txt`, {
      method: 'PUT', headers: { cookie, origin, 'content-type': 'text/plain' }, body: 'private',
    });
    await SELF.fetch(`${origin}/api/admin/entries/visibility`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id], isPublic: false }),
    });

    const guest = await SELF.fetch(`${origin}/file/${id}/private.txt`);
    expect(guest.status).toBe(404);
    expect((await guest.json() as { error: { code: string } }).error.code).toBe('ENTRY_NOT_FOUND');

    const admin = await SELF.fetch(`${origin}/file/${id}/private.txt`, { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect(admin.headers.get('cache-control')).toBe('private, no-store');
  });

  it('redirects a migrated legacy file URL to its stable entry URL', async () => {
    const db = (env as unknown as Env).DB;
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
      VALUES (?, ?, 4, 'text/plain', 'etag', ?, 1, 0, '')`).bind('legacy/old.txt', 'old.txt', now).run();
    await db.prepare(`INSERT INTO entries (
      id, parent_id, name, kind, storage_key, size, content_type, etag, status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
    ) VALUES (?, 'root', ?, 'file', ?, 4, 'text/plain', 'etag', 'ready', NULL, 1, 0, '', ?, ?)`)
      .bind('legacy-file-id', 'old.txt', 'legacy/old.txt', now, now).run();

    const response = await SELF.fetch(`${origin}/file/legacy/old.txt`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/file/legacy-file-id/old.txt');
  });

  it('returns structured errors for malformed IDs and arrays', async () => {
    const malformed = await SELF.fetch(`${origin}/api/fs/entries/bad%2Fid`);
    expect(malformed.status).toBe(404);
    expect((await malformed.json() as { error: { code: string } }).error.code).toBe('ENTRY_NOT_FOUND');

    const cookie = await login();
    const invalid = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: 'nope' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });
});
