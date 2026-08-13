import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import disablePikPakMounts from '../../migrations/0019_disable_pikpak_mounts.sql?raw';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

describe('retired storage driver migration', () => {
  it('makes existing PikPak mounts inactive without deleting their records', async () => {
    await db().prepare(`INSERT INTO mounts (
      id, name, mount_path, driver_type, provider, enabled, is_public,
      sort_order, root_item_id, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        'retired-pikpak', 'Retired PikPak', '/retired-pikpak', 'pikpak', 'pikpak', 1, 1,
        0, 'root', '{}', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z',
      )
      .run();

    await db().prepare(disablePikPakMounts).run();

    const mount = await db().prepare("SELECT id, enabled, is_public FROM mounts WHERE id = 'retired-pikpak'").first();
    expect(mount).toEqual({ id: 'retired-pikpak', enabled: 0, is_public: 0 });
  });
});
