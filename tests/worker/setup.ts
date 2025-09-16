import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import initial from '../../migrations/0001_initial.sql?raw';
import entries from '../../migrations/0002_entries.sql?raw';
import lock from '../../migrations/0003_legacy_object_migration_lock.sql?raw';
import reservations from '../../migrations/0004_legacy_object_migration_reservations.sql?raw';
import leaseExpiry from '../../migrations/0005_legacy_object_migration_lease_expiry.sql?raw';
import storageKeyImmutable from '../../migrations/0006_entries_storage_key_immutable.sql?raw';
import type { Env } from '../../src/worker/types';

beforeEach(async () => {
  const db = (env as unknown as Env).DB;
  for (const statement of `${initial}\n${entries}\n${lock}\n${reservations}\n${leaseExpiry}\n${storageKeyImmutable}`.split(/;\s+(?=(?:PRAGMA|CREATE|INSERT|DROP))/)) {
    const sql = statement.trim();
    if (sql) await db.prepare(sql).run();
  }
});
