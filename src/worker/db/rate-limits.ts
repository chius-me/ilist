export interface AuthRateLimitRow {
  key_hash: string;
  scope: string;
  window_started_at: number;
  failure_count: number;
  blocked_until: number;
  reservation_token: string | null;
  reservation_expires_at: number;
  updated_at: number;
}

export function getAuthRateLimit(db: D1Database, keyHash: string): Promise<AuthRateLimitRow | null> {
  return db.prepare('SELECT * FROM auth_rate_limits WHERE key_hash = ?').bind(keyHash).first<AuthRateLimitRow>();
}

export function reserveAuthRateLimitVerification(
  db: D1Database,
  keyHash: string,
  scope: string,
  reservationToken: string,
  now: number,
  windowSeconds: number,
  maxFailures: number,
  reservationSeconds: number,
): Promise<AuthRateLimitRow | null> {
  return db.prepare(`INSERT INTO auth_rate_limits (
      key_hash, scope, window_started_at, failure_count, blocked_until,
      reservation_token, reservation_expires_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, ?, ? + ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      scope = excluded.scope,
      window_started_at = CASE
        WHEN excluded.updated_at >= auth_rate_limits.window_started_at + ? THEN excluded.window_started_at
        ELSE auth_rate_limits.window_started_at
      END,
      failure_count = CASE
        WHEN excluded.updated_at >= auth_rate_limits.window_started_at + ? THEN 0
        ELSE auth_rate_limits.failure_count
      END,
      blocked_until = CASE
        WHEN excluded.updated_at >= auth_rate_limits.window_started_at + ? THEN 0
        ELSE auth_rate_limits.blocked_until
      END,
      reservation_token = excluded.reservation_token,
      reservation_expires_at = excluded.reservation_expires_at,
      updated_at = excluded.updated_at
    WHERE auth_rate_limits.reservation_expires_at <= excluded.updated_at
      AND (
        excluded.updated_at >= auth_rate_limits.window_started_at + ?
        OR (
          auth_rate_limits.failure_count < ?
          AND auth_rate_limits.blocked_until <= excluded.updated_at
        )
      )
    RETURNING *`)
    .bind(
      keyHash, scope, now, reservationToken, now, reservationSeconds, now,
      windowSeconds, windowSeconds, windowSeconds, windowSeconds, maxFailures,
    )
    .first<AuthRateLimitRow>();
}

export async function recordAuthRateLimitFailure(
  db: D1Database,
  keyHash: string,
  scope: string,
  reservationToken: string,
  now: number,
  windowSeconds: number,
  maxBackoffSeconds: number,
): Promise<number> {
  const row = await db.prepare(`UPDATE auth_rate_limits SET
      scope = ?,
      window_started_at = CASE
        WHEN ? >= window_started_at + ? THEN ?
        ELSE auth_rate_limits.window_started_at
      END,
      failure_count = CASE
        WHEN ? >= window_started_at + ? THEN 1
        ELSE auth_rate_limits.failure_count + 1
      END,
      blocked_until = CASE
        WHEN ? >= window_started_at + ? THEN ? + 1
        ELSE ? + MIN(?, 1 << auth_rate_limits.failure_count)
      END,
      reservation_token = NULL,
      reservation_expires_at = 0,
      updated_at = ?
    WHERE key_hash = ? AND reservation_token = ?
    RETURNING failure_count`)
    .bind(
      scope,
      now, windowSeconds, now,
      now, windowSeconds,
      now, windowSeconds, now,
      now, maxBackoffSeconds,
      now,
      keyHash, reservationToken,
    )
    .first<{ failure_count: number }>();
  return row?.failure_count ?? 0;
}

export async function clearAuthRateLimit(db: D1Database, keyHash: string, reservationToken: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM auth_rate_limits WHERE key_hash = ? AND reservation_token = ?')
    .bind(keyHash, reservationToken)
    .run();
  return result.meta.changes === 1;
}

export async function releaseAuthRateLimitVerification(
  db: D1Database,
  keyHash: string,
  reservationToken: string,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE auth_rate_limits
    SET reservation_token = NULL, reservation_expires_at = 0
    WHERE key_hash = ? AND reservation_token = ?`)
    .bind(keyHash, reservationToken)
    .run();
  return result.meta.changes === 1;
}

export async function deleteAuthRateLimitsBefore(
  db: D1Database,
  cutoff: number,
  limit = 100,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db.prepare(`DELETE FROM auth_rate_limits
    WHERE key_hash IN (
      SELECT key_hash FROM auth_rate_limits
      WHERE updated_at < ?
      ORDER BY updated_at ASC
      LIMIT ?
    )`)
    .bind(cutoff, boundedLimit)
    .run();
  return result.meta.changes;
}
