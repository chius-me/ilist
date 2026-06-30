import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/worker/types';
import mountsPrivateDefault from '../../migrations/0016_mounts_private_default.sql?raw';

const db = () => (env as unknown as Env).DB;

async function applyMigration(sql: string) {
  for (const statement of sql.split(/;\s+(?=(?:PRAGMA|CREATE|INSERT|DROP|ALTER))/)) {
    if (statement.trim()) await db().prepare(statement.trim()).run();
  }
}

describe('mounts schema', () => {
  beforeEach(async () => {
    await db().prepare('DELETE FROM mounts').run();
  });

  it('creates the complete mounts table', async () => {
    const result = await db().prepare('PRAGMA table_info(mounts)').all<{ name: string; dflt_value: string | null }>();

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
    expect(result.results.find((column) => column.name === 'is_public')?.dflt_value).toBe('0');
  });

  it('defaults raw inserts that omit publication to private', async () => {
    const now = '2026-07-22T00:00:00.000Z';
    await db().prepare(
      `INSERT INTO mounts (id, name, mount_path, driver_type, provider, created_at, updated_at)
       VALUES ('raw-private', 'Raw private', '/raw-private', 's3', 'custom', ?, ?)`,
    ).bind(now, now).run();

    const mount = await db().prepare("SELECT is_public FROM mounts WHERE id = 'raw-private'").first<{ is_public: number }>();
    expect(mount?.is_public).toBe(0);
  });

  it('preserves upgraded mount visibility, dependent rows, constraints, and indexes', async () => {
    const legacyPublicDefault = mountsPrivateDefault.replace(
      'is_public INTEGER NOT NULL DEFAULT 0 CHECK',
      'is_public INTEGER NOT NULL DEFAULT 1 CHECK',
    );
    await applyMigration(legacyPublicDefault);

    const now = '2026-07-22T00:00:00.000Z';
    await db().batch([
      db().prepare(
        `INSERT INTO mounts
           (id, name, mount_path, driver_type, provider, is_public, created_at, updated_at)
         VALUES (?, ?, ?, 's3', 'custom', ?, ?, ?)`,
      ).bind('upgrade-public', 'Upgrade public', '/upgrade-public', 1, now, now),
      db().prepare(
        `INSERT INTO mounts
           (id, name, mount_path, driver_type, provider, is_public, created_at, updated_at)
         VALUES (?, ?, ?, 's3', 'custom', ?, ?, ?)`,
      ).bind('upgrade-private', 'Upgrade private', '/upgrade-private', 0, now, now),
      db().prepare(
        `INSERT INTO storage_credentials (mount_id, ciphertext, key_version, created_at, updated_at)
         VALUES ('upgrade-public', 'ciphertext', 1, ?, ?)`,
      ).bind(now, now),
      db().prepare(
        `INSERT INTO oauth_states (state_hash, mount_id, verifier_ciphertext, expires_at, created_at)
         VALUES ('upgrade-state', 'upgrade-private', 'verifier', 2000000000, ?)`,
      ).bind(now),
      db().prepare(
        `INSERT INTO oauth_refresh_leases (mount_id, owner, expires_at)
         VALUES ('upgrade-private', 'worker', 2000000000)`,
      ),
      db().prepare("INSERT INTO sessions (id, expires_at, created_at) VALUES ('upgrade-session', 2000000000, 1900000000)"),
      db().prepare(
        `INSERT INTO upload_sessions
           (id, owner_session_id, mount_id, parent_item_id, name, size, part_size,
            provider_state_ciphertext, status, expires_at, created_at, updated_at)
         VALUES ('upgrade-upload', 'upgrade-session', 'upgrade-public', 'root', 'file.bin', 1, 1,
                 'state', 'active', 2000000000, ?, ?)`,
      ).bind(now, now),
      db().prepare(
        `INSERT INTO shares
           (id, token_hash, mount_id, provider_item_id, target_kind, name, created_at, updated_at)
         VALUES ('upgrade-share', 'upgrade-token', 'upgrade-private', 'item', 'file', 'Shared file', ?, ?)`,
      ).bind(now, now),
    ]);

    await applyMigration(mountsPrivateDefault);

    const mounts = await db().prepare(
      "SELECT id, is_public FROM mounts WHERE id LIKE 'upgrade-%' ORDER BY id",
    ).all<{ id: string; is_public: number }>();
    expect(mounts.results).toEqual([
      { id: 'upgrade-private', is_public: 0 },
      { id: 'upgrade-public', is_public: 1 },
    ]);
    for (const [table, idColumn, id] of [
      ['storage_credentials', 'mount_id', 'upgrade-public'],
      ['oauth_states', 'state_hash', 'upgrade-state'],
      ['oauth_refresh_leases', 'mount_id', 'upgrade-private'],
      ['upload_sessions', 'id', 'upgrade-upload'],
      ['shares', 'id', 'upgrade-share'],
    ] as const) {
      expect(await db().prepare(`SELECT 1 AS present FROM ${table} WHERE ${idColumn} = ?`).bind(id).first())
        .toEqual({ present: 1 });
    }

    const expectedIndexes = {
      mounts: ['mounts_mount_path_unique', 'mounts_name_normalized_unique'],
      storage_credentials: [],
      oauth_states: ['oauth_states_expires_at_index', 'oauth_states_mount_id_index'],
      oauth_refresh_leases: [],
      upload_sessions: [
        'upload_sessions_cleanup_order',
        'upload_sessions_expiration',
        'upload_sessions_owner_status',
        'upload_sessions_terminal_lease',
      ],
      shares: ['shares_admin_order', 'shares_mount_id'],
    };
    for (const [table, expected] of Object.entries(expectedIndexes)) {
      const indexes = await db().prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
      ).bind(table).all<{ name: string }>();
      expect(indexes.results.map(({ name }) => name)).toEqual(expected);
    }

    const tableSql = async (table: string) => (await db().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind(table).first<{ sql: string }>())?.sql ?? '';
    expect(await tableSql('mounts')).toMatch(/DEFAULT 0 CHECK \(is_public IN \(0, 1\)\)/);
    expect(await tableSql('mounts')).toContain("DEFAULT '{}' CHECK (json_valid(config_json))");
    expect(await tableSql('upload_sessions')).toContain("status IN ('active', 'completing', 'completed', 'aborted')");
    expect(await tableSql('upload_sessions')).toContain("terminal_operation IN ('complete', 'abort')");
    expect(await tableSql('shares')).toContain("target_kind IN ('file', 'folder')");
    expect(await tableSql('shares')).toContain('allow_download INTEGER NOT NULL DEFAULT 1 CHECK');
    for (const table of ['storage_credentials', 'oauth_states', 'oauth_refresh_leases', 'upload_sessions', 'shares']) {
      const foreignKeys = await db().prepare(`PRAGMA foreign_key_list(${table})`).all<{ table: string; on_delete: string }>();
      expect(foreignKeys.results).toContainEqual(expect.objectContaining({ table: 'mounts', on_delete: 'CASCADE' }));
    }
    expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

    await db().prepare(
      `INSERT INTO mounts (id, name, mount_path, driver_type, provider, created_at, updated_at)
       VALUES ('upgrade-omitted', 'Upgrade omitted', '/upgrade-omitted', 'native-r2', 'cloudflare-r2', ?, ?)`,
    ).bind(now, now).run();
    expect(await db().prepare("SELECT is_public FROM mounts WHERE id = 'upgrade-omitted'").first())
      .toEqual({ is_public: 0 });
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
    await expect(insert('four', ' Photos ', '/trimmed')).rejects.toThrow();
  });
});
