import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/worker/auth';
import {
  acquireLegacyObjectMigrationLease,
  countLegacyObjectMutationReservations,
  LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS,
  releaseLegacyObjectMigrationLease,
  releaseLegacyObjectMutationReservation,
  reserveLegacyObjectMutation,
} from '../../src/worker/db';
import { routeRequest } from '../../src/worker/router';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;
const workerEnv = () => env as unknown as Env;

describe('legacy object migration lock', () => {
  beforeEach(async () => {
    await db()
      .prepare("DELETE FROM settings WHERE key = 'legacy_object_migration_lock' OR key LIKE 'legacy_object_mutation_reservation_%'")
      .run();
    await db().prepare("DELETE FROM objects WHERE key = 'locked.txt'").run();
    await db().prepare("DELETE FROM objects WHERE key = 'triggered.txt'").run();
  });

  it('blocks an authenticated legacy PATCH while the migration lock is held', async () => {
    await db()
      .prepare(
        `INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
         VALUES ('locked.txt', 'locked.txt', 1, 'text/plain', 'etag', '2026-07-10T00:00:00.000Z', 1, 0, '')`,
      )
      .run();
    await acquireLegacyObjectMigrationLease(db(), 'migration-token');
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

  it('blocks direct writes only for live JSON migration and reservation leases', async () => {
    const now = (await db().prepare("SELECT CAST(unixepoch() * 1000 AS INTEGER) AS now").first<{ now: number }>())!.now;
    const insert = () =>
      db()
        .prepare(
          `INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
           VALUES ('triggered.txt', 'triggered.txt', 1, 'text/plain', 'etag', '2026-07-10T00:00:00.000Z', 1, 0, '')`,
        )
        .run();

    await db()
      .prepare("INSERT INTO settings (key, value) VALUES ('legacy_object_migration_lock', ?)")
      .bind(JSON.stringify({ owner: 'live-migration', expires_at: now + 60_000 }))
      .run();

    await expect(insert()).rejects.toThrow('legacy object migration');
    await db().prepare("DELETE FROM settings WHERE key = 'legacy_object_migration_lock'").run();

    await db()
      .prepare("INSERT INTO settings (key, value) VALUES ('legacy_object_migration_lock', ?)")
      .bind(JSON.stringify({ owner: 'expired-migration', expires_at: now - 1 }))
      .run();
    await expect(insert()).resolves.toMatchObject({ success: true });
    await db().prepare("DELETE FROM objects WHERE key = 'triggered.txt'").run();
    await db().prepare("UPDATE settings SET value = 'legacy-migration-token' WHERE key = 'legacy_object_migration_lock'").run();
    await expect(insert()).resolves.toMatchObject({ success: true });
    await db().prepare("DELETE FROM objects WHERE key = 'triggered.txt'").run();

    await db()
      .prepare("UPDATE settings SET value = ? WHERE key = 'legacy_object_migration_lock'")
      .bind(JSON.stringify({ owner: 'live-migration', expires_at: now + 60_000 }))
      .run();
    await db()
      .prepare("INSERT INTO settings (key, value) VALUES ('legacy_object_mutation_reservation_expired', ?)")
      .bind(JSON.stringify({ owner: 'expired-reservation', expires_at: now - 1 }))
      .run();
    await expect(insert()).rejects.toThrow('legacy object migration');
    await db().prepare("UPDATE settings SET value = ? WHERE key = 'legacy_object_mutation_reservation_expired'")
      .bind(JSON.stringify({ owner: 'live-reservation', expires_at: now + 60_000 }))
      .run();
    await expect(insert()).resolves.toMatchObject({ success: true });
  });

  it('blocks a new reservation after migration has claimed the lock and drains an earlier reservation', async () => {
    const reservation = await reserveLegacyObjectMutation(db(), 'mutation-owner', 1_000);
    expect(reservation).not.toBeNull();
    expect(await acquireLegacyObjectMigrationLease(db(), 'migration-owner', 1_000, 1_000)).toBe(true);
    expect(await reserveLegacyObjectMutation(db(), 'later-mutation', 1_001)).toBeNull();
    expect(await countLegacyObjectMutationReservations(db(), 1_000)).toBe(1);

    await releaseLegacyObjectMutationReservation(db(), reservation!);
    expect(await countLegacyObjectMutationReservations(db(), 1_000)).toBe(0);
    await releaseLegacyObjectMigrationLease(db(), 'migration-owner');
  });

  it('releases a PUT reservation when the R2 operation fails before writing the index', async () => {
    const session = await createSession(workerEnv());
    const response = await routeRequest(
      new Request('https://ilist.example/api/admin/objects/failure.txt', {
        method: 'PUT',
        headers: { cookie: `ilist_session=${session.token}` },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(400);
    expect(await countLegacyObjectMutationReservations(db())).toBe(0);
  });

  it('counts only live mutation reservation leases and keeps their owner-bound release safe', async () => {
    const reservation = await reserveLegacyObjectMutation(db(), 'reservation-owner', 1_000, 100);
    expect(reservation).not.toBeNull();
    await expect(
      db().prepare('SELECT value FROM settings WHERE key = ?').bind(reservation!.key).first<{ value: string }>(),
    ).resolves.toMatchObject({ value: JSON.stringify({ owner: 'reservation-owner', expires_at: 1_100 }) });
    expect(await countLegacyObjectMutationReservations(db(), 1_050)).toBe(1);

    await releaseLegacyObjectMutationReservation(db(), { ...reservation!, owner: 'different-owner' });
    expect(await countLegacyObjectMutationReservations(db(), 1_050)).toBe(1);
    expect(await countLegacyObjectMutationReservations(db(), 1_101)).toBe(0);
    expect(await acquireLegacyObjectMigrationLease(db(), 'migration-owner', 1_101, 100)).toBe(true);
  });

  it('uses a mutation lease duration that covers normal R2 work', () => {
    expect(LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('recovers an expired migration lease but refuses to steal a live lease', async () => {
    expect(await acquireLegacyObjectMigrationLease(db(), 'first-owner', 1_000, 100)).toBe(true);
    expect(await acquireLegacyObjectMigrationLease(db(), 'second-owner', 1_050, 100)).toBe(false);
    expect(await acquireLegacyObjectMigrationLease(db(), 'second-owner', 1_101, 100)).toBe(true);

    await releaseLegacyObjectMigrationLease(db(), 'first-owner');
    expect(await db().prepare("SELECT value FROM settings WHERE key = 'legacy_object_migration_lock'").first()).toMatchObject({
      value: expect.stringContaining('second-owner'),
    });
  });
});
