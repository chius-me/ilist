import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/worker/auth';
import { routeRequest } from '../../src/worker/router';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;
const workerEnv = () => env as unknown as Env;

describe('legacy object migration lock', () => {
  beforeEach(async () => {
    await db().prepare("DELETE FROM settings WHERE key = 'legacy_object_migration_lock'").run();
    await db().prepare("DELETE FROM objects WHERE key = 'locked.txt'").run();
  });

  it('blocks an authenticated legacy PATCH while the migration lock is held', async () => {
    await db()
      .prepare(
        `INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
         VALUES ('locked.txt', 'locked.txt', 1, 'text/plain', 'etag', '2026-07-10T00:00:00.000Z', 1, 0, '')`,
      )
      .run();
    await db().prepare("INSERT INTO settings (key, value) VALUES ('legacy_object_migration_lock', 'migration-token')").run();
    const session = await createSession(workerEnv());

    const response = await routeRequest(
      new Request('https://ilist.example/api/admin/objects/locked.txt', {
        method: 'PATCH',
        headers: { cookie: `ilist_session=${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ description: 'must not apply' }),
      }),
      workerEnv(),
    );

    expect(response.status).toBe(503);
    await expect(db().prepare("SELECT description FROM objects WHERE key = 'locked.txt'").first()).resolves.toMatchObject({ description: '' });
  });

  it('rejects direct legacy object writes while the migration lock is held', async () => {
    await db().prepare("INSERT INTO settings (key, value) VALUES ('legacy_object_migration_lock', 'migration-token')").run();

    await expect(
      db()
        .prepare(
          `INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
           VALUES ('locked.txt', 'locked.txt', 1, 'text/plain', 'etag', '2026-07-10T00:00:00.000Z', 1, 0, '')`,
        )
        .run(),
    ).rejects.toThrow('legacy object migration');
  });
});
