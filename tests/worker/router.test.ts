import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { routeRequest } from '../../src/worker/router';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';

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

  it.each([
    ['HTML', 'report.html', 'text/html; charset=utf-8', '<script>alert(1)</script>'],
    ['SVG', 'icon.svg', 'image/svg+xml', '<svg><script>alert(1)</script></svg>'],
  ])('isolates active native R2 $s content without changing Range semantics', async (_label, name, contentType, body) => {
    const cookie = await login();
    const id = `active-${name.replace('.', '-')}-test`;
    await SELF.fetch(`${origin}/api/admin/files/${id}?parentId=root&name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': contentType },
      body,
    });

    const response = await SELF.fetch(`${origin}/file/${id}/${name}`, {
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
