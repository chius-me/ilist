import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

describe('mounts schema', () => {
  beforeEach(async () => {
    await db().prepare('DELETE FROM mounts').run();
  });

  it('creates the complete mounts table', async () => {
    const result = await db().prepare('PRAGMA table_info(mounts)').all<{ name: string }>();

    expect(result.results.map((column) => column.name)).toEqual([
      'id',
      'name',
      'mount_path',
      'driver_type',
      'provider',
      'enabled',
      'is_public',
      'sort_order',
      'root_item_id',
      'config_json',
      'created_at',
      'updated_at',
    ]);
  });

  it('enforces unique mount paths and normalized names', async () => {
    const now = '2026-07-13T00:00:00.000Z';
    const insert = (id: string, name: string, mountPath: string) =>
      db()
        .prepare(
          `INSERT INTO mounts (id, name, mount_path, driver_type, provider, created_at, updated_at)
           VALUES (?, ?, ?, 's3', 'custom', ?, ?)`,
        )
        .bind(id, name, mountPath, now, now)
        .run();

    await insert('one', 'Photos', '/photos');
    await expect(insert('two', 'Other', '/photos')).rejects.toThrow();
    await expect(insert('three', 'photos', '/other')).rejects.toThrow();
  });
});
