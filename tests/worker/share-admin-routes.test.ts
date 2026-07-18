import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';

function workerEnv(): Env {
  return env as unknown as Env;
}

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function privateFile(id = crypto.randomUUID()): Promise<string> {
  const now = new Date().toISOString();
  await workerEnv().DB.prepare('DELETE FROM shares').run();
  await workerEnv().DB.prepare("DELETE FROM entries WHERE parent_id = 'root' AND name = 'secret.txt'").run();
  await workerEnv().DB.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag, status,
    lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) VALUES (?, 'root', 'secret.txt', 'file', ?, 6, 'text/plain', 'etag', 'ready', NULL, 0, 0, '', ?, ?)`)
    .bind(id, `shares/${id}.txt`, now, now).run();
  await workerEnv().R2_BUCKET.put(`shares/${id}.txt`, 'secret');
  return id;
}

async function createShare(cookie: string, entryId: string, overrides: Record<string, unknown> = {}) {
  return SELF.fetch(`${origin}/api/admin/shares`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ entryId, allowDownload: false, ...overrides }),
  });
}

describe('share administration routes', () => {
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
      name: 'secret.txt', targetKind: 'file', mountName: 'R2',
      protected: true, expiresAt: '2099-01-01T00:00:00.000Z', allowDownload: false, enabled: true,
    });
    expect(JSON.stringify(created.data.share)).not.toMatch(/tokenHash|passwordHash|providerItemId|secret\.txt.*shares\//);

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
