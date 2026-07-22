import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import initial from '../../migrations/0001_initial.sql?raw';
import entries from '../../migrations/0002_entries.sql?raw';
import lock from '../../migrations/0003_legacy_object_migration_lock.sql?raw';
import reservations from '../../migrations/0004_legacy_object_migration_reservations.sql?raw';
import leaseExpiry from '../../migrations/0005_legacy_object_migration_lease_expiry.sql?raw';
import storageKeyImmutable from '../../migrations/0006_entries_storage_key_immutable.sql?raw';
import storageRecovery from '../../migrations/0007_storage_recovery_operations.sql?raw';
import mounts from '../../migrations/0008_mounts.sql?raw';
import storageCredentials from '../../migrations/0009_storage_credentials.sql?raw';
import nativeR2CompatibilityMount from '../../migrations/0010_native_r2_compat_mount.sql?raw';
import oauthStates from '../../migrations/0011_oauth_states.sql?raw';
import uploadSessions from '../../migrations/0012_upload_sessions.sql?raw';
import uploadTerminalLeases from '../../migrations/0013_upload_terminal_leases.sql?raw';
import shares from '../../migrations/0014_shares.sql?raw';
import authRateLimits from '../../migrations/0015_auth_rate_limits.sql?raw';
import type { Env } from '../../src/worker/types';

beforeEach(async () => {
  const db = (env as unknown as Env).DB;
  for (const statement of `${initial}\n${entries}\n${lock}\n${reservations}\n${leaseExpiry}\n${storageKeyImmutable}\n${storageRecovery}\n${mounts}\n${storageCredentials}\n${nativeR2CompatibilityMount}\n${oauthStates}\n${uploadSessions}\n${uploadTerminalLeases}\n${shares}\n${authRateLimits}`.split(/;\s+(?=(?:PRAGMA|CREATE|INSERT|DROP|ALTER))/)) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      await db.prepare(sql).run();
    } catch (error) {
      const normalizedSql = sql.replace(/\s+/g, ' ');
      const repeatableAddColumn =
        normalizedSql.startsWith('ALTER TABLE entries ADD COLUMN lifecycle_owner')
        || normalizedSql.startsWith('ALTER TABLE upload_sessions ADD COLUMN terminal_')
        || normalizedSql.startsWith('ALTER TABLE upload_sessions ADD COLUMN cleanup_attempted_at');
      if (!(repeatableAddColumn && error instanceof Error && error.message.includes('duplicate column'))) {
        throw error;
      }
    }
  }

  const foreignKeys = await db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
  if (foreignKeys?.foreign_keys !== 1) throw new Error('Worker test D1 must enforce foreign keys');
  await db.prepare('DELETE FROM auth_rate_limits').run();
});
