import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { routeRequest } from '../../src/worker/router';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';

function workerEnv(): Env {
  return env as unknown as Env;
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

describe('filesystem API', () => {
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
    valid = false;
    expect((await attempt()).status).toBe(401);
    expect(verificationCalls).toBe(3);
  });

  it('lists the native R2 mount while stable and legacy file routes still work', async () => {
    const db = (env as unknown as Env).DB;
    const cookie = await login();
    const id = 'compat-file-test';
    const upload = await SELF.fetch(`${origin}/api/admin/files/${id}?parentId=root&name=compat.txt`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'text/plain' },
      body: 'native-r2-data',
    });
    expect(upload.status).toBe(200);

    const guest = await SELF.fetch(`${origin}/api/fs/list?path=/`);
    expect(guest.status).toBe(200);
    expect(await guest.json()).toMatchObject({
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'native-r2', name: 'R2', kind: 'folder', mountId: 'native-r2' }),
        ]),
      },
    });

    const mounted = await SELF.fetch(`${origin}/api/fs/list?path=/R2`);
    expect(mounted.status).toBe(200);
    expect(await mounted.json()).toMatchObject({
      data: { items: expect.arrayContaining([expect.objectContaining({ id, name: 'compat.txt' })]) },
    });

    const admin = await SELF.fetch(`${origin}/api/fs/list?path=/`, { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect((await admin.json() as { data: { current: { capabilities: { rename: boolean } } } }).data.current.capabilities.rename).toBe(false);

    const stable = await SELF.fetch(`${origin}/file/${id}/ignored-name`);
    expect(stable.status).toBe(200);
    await expect(stable.text()).resolves.toBe('native-r2-data');

    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
      VALUES (?, ?, 14, 'text/plain', 'etag', ?, 1, 0, '')`).bind('legacy/compat.txt', 'compat.txt', now).run();
    await db.prepare(`INSERT INTO entries (
      id, parent_id, name, kind, storage_key, size, content_type, etag, status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
    ) VALUES (?, 'root', ?, 'file', ?, 14, 'text/plain', 'etag', 'ready', NULL, 1, 0, '', ?, ?)`).bind(
      'legacy-compat-id', 'legacy-compat.txt', 'legacy/compat.txt', now, now,
    ).run();
    const legacy = await SELF.fetch(`${origin}/file/legacy/compat.txt`, { redirect: 'manual' });
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get('location')).toBe('/file/legacy-compat-id/legacy-compat.txt');
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

  it('isolates active R2 content without changing Range semantics', async () => {
    const cookie = await login();
    const id = 'active-html-test';
    await SELF.fetch(`${origin}/api/admin/files/${id}?parentId=root&name=report.html`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'text/html; charset=utf-8' },
      body: '<script>alert(1)</script>',
    });

    const response = await SELF.fetch(`${origin}/file/${id}/report.html`, {
      headers: { range: 'bytes=0-7' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-7/25');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.text()).resolves.toBe('<script>');
  });

  it('adds application security headers to APIs and Workers Assets', async () => {
    const api = await SELF.fetch(`${origin}/api/public/tree`);
    const asset = await SELF.fetch(`${origin}/`);

    for (const response of [api, asset]) {
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    }
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
