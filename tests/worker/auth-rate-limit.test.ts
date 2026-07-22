import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  assertAuthAllowed,
  clearAuthFailures,
  recordAuthFailure,
  releaseAuthReservation,
  type AuthRateLimitPolicy,
} from '../../src/worker/auth-rate-limit';
import { deleteAuthRateLimitsBefore } from '../../src/worker/db';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

function request(ip?: string, forwardedFor?: string): Request {
  const headers = new Headers();
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (forwardedFor) headers.set('X-Forwarded-For', forwardedFor);
  return new Request('https://ilist.example/api/admin/login', { headers });
}

describe('authentication rate limiter', () => {
  it('uses a normalized, HMAC-derived identity without storing the IP or subject', async () => {
    let now = 1_000;
    const policy: AuthRateLimitPolicy = { maxFailures: 5, windowSeconds: 60, now: () => now };
    const context = await assertAuthAllowed(workerEnv(), request('203.0.113.4'), 'admin-login', ' Admin ', policy);
    await recordAuthFailure(context);

    await expect(assertAuthAllowed(
      workerEnv(), request('203.0.113.4'), 'admin-login', 'admin', policy,
    )).rejects.toMatchObject({ status: 429, code: 'AUTH_RATE_LIMITED', details: { retryAfter: 1 } });

    const rows = await workerEnv().DB.prepare('SELECT * FROM auth_rate_limits').all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results?.[0]).toMatchObject({ scope: 'admin-login', failure_count: 1 });
    expect(JSON.stringify(rows.results)).not.toContain('203.0.113.4');
    expect(rows.results?.[0]).not.toHaveProperty('subject');
    expect(rows.results?.[0]).not.toHaveProperty('client_ip');
    expect(rows.results?.[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    now += 1;
  });

  it('enforces fixed windows and 1/2/4/8 second backoff', async () => {
    let now = 2_000;
    const policy: AuthRateLimitPolicy = { maxFailures: 5, windowSeconds: 60, now: () => now };
    const req = request('203.0.113.5');

    for (const retryAfter of [1, 2, 4, 8]) {
      const context = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
      await recordAuthFailure(context);
      await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy))
        .rejects.toMatchObject({ status: 429, details: { retryAfter } });
      now += retryAfter;
    }

    const threshold = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
    await recordAuthFailure(threshold);
    await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy))
      .rejects.toMatchObject({ status: 429, details: { retryAfter: 45 } });

    now = 2_023;
    await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy))
      .rejects.toMatchObject({ status: 429, details: { retryAfter: 37 } });
    now = 2_060;
    await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy)).resolves.toBeDefined();
  });

  it('ignores X-Forwarded-For and only permits explicit test dependency injection without a Cloudflare IP', async () => {
    let now = 3_000;
    const policy: AuthRateLimitPolicy = { maxFailures: 5, windowSeconds: 60, now: () => now };
    const first = await assertAuthAllowed(
      workerEnv(), request('203.0.113.6', '198.51.100.1'), 'admin-login', 'admin', policy,
    );
    await recordAuthFailure(first);

    await expect(assertAuthAllowed(
      workerEnv(), request('203.0.113.6', '198.51.100.2'), 'admin-login', 'admin', policy,
    )).rejects.toMatchObject({ status: 429 });
    await expect(assertAuthAllowed(
      workerEnv(), request('203.0.113.7', '198.51.100.1'), 'admin-login', 'admin', policy,
    )).resolves.toBeDefined();

    await expect(assertAuthAllowed(
      workerEnv(), request(undefined, '198.51.100.1'), 'admin-login', 'admin', policy,
    )).rejects.toMatchObject({ status: 500, code: 'AUTH_CLIENT_IP_UNAVAILABLE' });
    await expect(assertAuthAllowed(
      workerEnv(), request(), 'admin-login', 'admin', { ...policy, clientIp: '127.0.0.1' },
    )).resolves.toBeDefined();
    now += 1;
  });

  it('clears failures after successful authentication', async () => {
    const policy: AuthRateLimitPolicy = { maxFailures: 5, windowSeconds: 60, now: () => 4_000 };
    const req = request('203.0.113.8');
    const context = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
    await expect(clearAuthFailures(context)).resolves.toBe(true);
    await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy)).resolves.toBeDefined();
  });

  it('atomically grants at most one verification reservation for concurrent attempts', async () => {
    const policy: AuthRateLimitPolicy = {
      maxFailures: 5,
      windowSeconds: 60,
      now: () => 5_000,
      clientIp: '203.0.113.9',
    };
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => assertAuthAllowed(
      workerEnv(), request(), 'admin-login', 'admin', policy,
    )));
    const granted = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');

    expect(granted).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        code: 'AUTH_RATE_LIMITED',
        details: { retryAfter: 30 },
      });
    }
    await clearAuthFailures((granted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof assertAuthAllowed>>>).value);
  });

  it('recovers expired leases without allowing stale requests to clear or convert a newer reservation', async () => {
    let now = 6_000;
    const policy: AuthRateLimitPolicy = {
      maxFailures: 5,
      windowSeconds: 60,
      now: () => now,
      clientIp: '203.0.113.10',
    };
    const stale = await assertAuthAllowed(workerEnv(), request(), 'admin-login', 'admin', policy);
    now += 31;
    const current = await assertAuthAllowed(workerEnv(), request(), 'admin-login', 'admin', policy);

    await expect(clearAuthFailures(stale)).resolves.toBe(false);
    await expect(assertAuthAllowed(workerEnv(), request(), 'admin-login', 'admin', policy))
      .rejects.toMatchObject({ status: 429, details: { retryAfter: 30 } });
    await expect(recordAuthFailure(stale)).resolves.toBe(0);
    await expect(recordAuthFailure(current)).resolves.toBe(1);
    await expect(assertAuthAllowed(workerEnv(), request(), 'admin-login', 'admin', policy))
      .rejects.toMatchObject({ status: 429, details: { retryAfter: 1 } });
  });

  it('releases only the owned reservation while preserving prior failures', async () => {
    let now = 7_000;
    const policy: AuthRateLimitPolicy = {
      maxFailures: 5,
      windowSeconds: 60,
      now: () => now,
      clientIp: '203.0.113.11',
    };
    const req = request();
    const failed = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
    await recordAuthFailure(failed);
    now += 1;

    const abandoned = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
    await expect(releaseAuthReservation(abandoned)).resolves.toBe(true);
    const state = await workerEnv().DB.prepare('SELECT failure_count FROM auth_rate_limits WHERE key_hash = ?')
      .bind(abandoned.keyHash).first<{ failure_count: number }>();
    expect(state?.failure_count).toBe(1);

    const current = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
    await expect(releaseAuthReservation(abandoned)).resolves.toBe(false);
    await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy))
      .rejects.toMatchObject({ status: 429, details: { retryAfter: 30 } });
    await expect(releaseAuthReservation(current)).resolves.toBe(true);
  });

  it('bounds opportunistic cleanup and leaves recent records intact', async () => {
    const db = workerEnv().DB;
    for (const [key, updatedAt] of [['a', 10], ['b', 20], ['c', 30], ['recent', 100]] as const) {
      await db.prepare(`INSERT INTO auth_rate_limits (
        key_hash, scope, window_started_at, failure_count, blocked_until,
        reservation_token, reservation_expires_at, updated_at
      ) VALUES (?, 'admin-login', ?, 1, ?, NULL, 0, ?)`).bind(key, updatedAt, updatedAt, updatedAt).run();
    }

    await expect(deleteAuthRateLimitsBefore(db, 50, 2)).resolves.toBe(2);
    const remaining = await db.prepare('SELECT key_hash FROM auth_rate_limits ORDER BY updated_at').all<{ key_hash: string }>();
    expect(remaining.results).toEqual([{ key_hash: 'c' }, { key_hash: 'recent' }]);
  });
});
