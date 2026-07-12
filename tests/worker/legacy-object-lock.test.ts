import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/worker/auth';
import {
  acquireLegacyObjectMigrationLease,
  countLegacyObjectMutationReservations,
  LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS,
  releaseLegacyObjectMigrationLease,
  releaseLegacyObjectMutationReservation,
  renewLegacyObjectMutationReservation,
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
    await db().prepare('DROP TABLE IF EXISTS heartbeat_audit').run();
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
        headers: { cookie: `ilist_session=${session.token}`, 'content-type': 'application/json', origin: 'https://ilist.example' },
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
        headers: { cookie: `ilist_session=${session.token}`, origin: 'https://ilist.example' },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(400);
    expect(await countLegacyObjectMutationReservations(db())).toBe(0);
  });

  it('keeps a streamed PUT reservation live past its initial lease and renews before the index write', async () => {
    let now = 1_000;
    let heartbeat: (() => void) | undefined;
    let requestBody: ReadableStream | null = null;

    await db().prepare('CREATE TABLE heartbeat_audit (reservation_value TEXT NOT NULL)').run();
    await db()
      .prepare(`CREATE TRIGGER record_put_reservation BEFORE INSERT ON objects
        WHEN NEW.key = 'heartbeat.txt'
        BEGIN
          INSERT INTO heartbeat_audit (reservation_value)
          SELECT value FROM settings WHERE key GLOB 'legacy_object_mutation_reservation_*';
        END`)
      .run();

    const timedEnv = Object.create(workerEnv()) as Env;
    timedEnv.R2_BUCKET = {
      put: async (_key: string, body: ReadableStream) => {
        requestBody = body;
        now = 1_050;
        await heartbeat!();
        now = 1_125;
        await heartbeat!();
        expect(await countLegacyObjectMutationReservations(db(), now)).toBe(1);
        now = 1_130;
        return { size: 4, etag: 'heartbeat-etag', httpEtag: 'heartbeat-etag' } as R2Object;
      },
    } as unknown as R2Bucket;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    const session = await createSession(workerEnv());
    const response = await routeRequest(
      new Request('https://ilist.example/api/admin/objects/heartbeat.txt', {
        method: 'PUT',
        headers: { cookie: `ilist_session=${session.token}`, 'content-type': 'application/octet-stream', origin: 'https://ilist.example' },
        body: stream,
      }),
      timedEnv,
      {
        legacyObjectMutationReservation: {
          now: () => now,
          leaseDurationMs: 100,
          heartbeatIntervalMs: 25,
          setInterval: (callback) => {
            heartbeat = callback;
            return 1;
          },
          clearInterval: () => undefined,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(requestBody).toBe(stream);
    await expect(db().prepare('SELECT reservation_value FROM heartbeat_audit').first<{ reservation_value: string }>()).resolves.toEqual({
      reservation_value: expect.stringContaining('"expires_at":1230'),
    });
    expect(await countLegacyObjectMutationReservations(db(), now)).toBe(0);
    await heartbeat!();
    expect(await countLegacyObjectMutationReservations(db(), now)).toBe(0);
  });

  it('does not write the index or release another owner after PUT ownership is lost', async () => {
    const now = 1_000;
    const timedEnv = Object.create(workerEnv()) as Env;
    timedEnv.R2_BUCKET = {
      put: async () => {
        const reservation = await db()
          .prepare("SELECT key FROM settings WHERE key GLOB 'legacy_object_mutation_reservation_*'")
          .first<{ key: string }>();
        await db()
          .prepare('UPDATE settings SET value = ? WHERE key = ?')
          .bind(JSON.stringify({ owner: 'replacement-owner', expires_at: now + 100 }), reservation!.key)
          .run();
        return { size: 4, etag: 'lost-etag', httpEtag: 'lost-etag' } as R2Object;
      },
    } as unknown as R2Bucket;
    const session = await createSession(workerEnv());

    const response = await routeRequest(
      new Request('https://ilist.example/api/admin/objects/lost.txt', {
        method: 'PUT',
        headers: { cookie: `ilist_session=${session.token}`, origin: 'https://ilist.example' },
        body: new ReadableStream(),
      }),
      timedEnv,
      { legacyObjectMutationReservation: { now: () => now, leaseDurationMs: 100 } },
    );

    expect(response.status).toBe(503);
    await expect(db().prepare("SELECT key FROM objects WHERE key = 'lost.txt'").first()).resolves.toBeNull();
    await expect(
      db().prepare("SELECT value FROM settings WHERE key GLOB 'legacy_object_mutation_reservation_*'").first<{ value: string }>(),
    ).resolves.toMatchObject({ value: expect.stringContaining('replacement-owner') });
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

  it('renews only a live reservation held by its current owner', async () => {
    const reservation = await reserveLegacyObjectMutation(db(), 'reservation-owner', 1_000, 100);
    expect(reservation).not.toBeNull();

    expect(await renewLegacyObjectMutationReservation(db(), reservation!, 1_050, 100)).toBe(true);
    await expect(
      db().prepare('SELECT value FROM settings WHERE key = ?').bind(reservation!.key).first<{ value: string }>(),
    ).resolves.toMatchObject({ value: JSON.stringify({ owner: 'reservation-owner', expires_at: 1_150 }) });

    expect(
      await renewLegacyObjectMutationReservation(db(), { ...reservation!, owner: 'different-owner' }, 1_075, 100),
    ).toBe(false);
    expect(await renewLegacyObjectMutationReservation(db(), reservation!, 1_151, 100)).toBe(false);
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
