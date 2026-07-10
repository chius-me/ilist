import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import initial from '../../migrations/0001_initial.sql?raw';
import entries from '../../migrations/0002_entries.sql?raw';
import lock from '../../migrations/0003_legacy_object_migration_lock.sql?raw';
import reservations from '../../migrations/0004_legacy_object_migration_reservations.sql?raw';
import type { Env } from '../../src/worker/types';

beforeEach(async () => {
  const db = (env as unknown as Env).DB;
  for (const statement of `${initial}\n${entries}\n${lock}\n${reservations}`.split(/;\s+(?=(?:PRAGMA|CREATE|INSERT|DROP))/)) {
    const sql = statement.trim();
    if (sql) await db.prepare(sql).run();
  }
});
