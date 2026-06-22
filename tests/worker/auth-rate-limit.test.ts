import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  assertAuthAllowed,
  clearAuthFailures,
  recordAuthFailure,
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

  it('ignores X-Forwarded-For and requires an explicit local fallback when Cloudflare IP is absent', async () => {
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

    const productionLikeEnv = { ...workerEnv(), AUTH_RATE_LIMIT_TEST_CLIENT_IP: undefined };
    await expect(assertAuthAllowed(
      productionLikeEnv, request(undefined, '198.51.100.1'), 'admin-login', 'admin', policy,
    )).rejects.toMatchObject({ status: 500, code: 'AUTH_CLIENT_IP_UNAVAILABLE' });
    await expect(assertAuthAllowed(
      workerEnv(), request(), 'admin-login', 'admin', policy,
    )).resolves.toBeDefined();
    now += 1;
  });

  it('clears failures after successful authentication', async () => {
    const policy: AuthRateLimitPolicy = { maxFailures: 5, windowSeconds: 60, now: () => 4_000 };
    const req = request('203.0.113.8');
    const context = await assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy);
    await recordAuthFailure(context);
    await clearAuthFailures(context);
    await expect(assertAuthAllowed(workerEnv(), req, 'admin-login', 'admin', policy)).resolves.toBeDefined();
  });

  it('bounds opportunistic cleanup and leaves recent records intact', async () => {
    const db = workerEnv().DB;
    for (const [key, updatedAt] of [['a', 10], ['b', 20], ['c', 30], ['recent', 100]] as const) {
      await db.prepare(`INSERT INTO auth_rate_limits (
        key_hash, scope, window_started_at, failure_count, blocked_until, updated_at
      ) VALUES (?, 'admin-login', ?, 1, ?, ?)`).bind(key, updatedAt, updatedAt, updatedAt).run();
    }

    await expect(deleteAuthRateLimitsBefore(db, 50, 2)).resolves.toBe(2);
    const remaining = await db.prepare('SELECT key_hash FROM auth_rate_limits ORDER BY updated_at').all<{ key_hash: string }>();
    expect(remaining.results).toEqual([{ key_hash: 'c' }, { key_hash: 'recent' }]);
  });
});
