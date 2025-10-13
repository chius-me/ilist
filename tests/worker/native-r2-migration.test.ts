import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import nativeR2CompatibilityMount from '../../migrations/0010_native_r2_compat_mount.sql?raw';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

describe('native R2 compatibility migration', () => {
  it('is applied by shared Worker test setup', async () => {
    const mount = await db().prepare("SELECT * FROM mounts WHERE id = 'native-r2'").first();

    expect(mount).toMatchObject({
      id: 'native-r2',
      name: 'R2',
      mount_path: '/R2',
      driver_type: 'native-r2',
      provider: 'cloudflare-r2',
      enabled: 1,
      is_public: 1,
      root_item_id: 'root',
    });
  });

  it('remains idempotent when migration SQL is reapplied', async () => {
    await db().prepare(nativeR2CompatibilityMount).run();

    const result = await db().prepare("SELECT id FROM mounts WHERE driver_type = 'native-r2'").all();
    expect(result.results).toEqual([{ id: 'native-r2' }]);
  });
});
