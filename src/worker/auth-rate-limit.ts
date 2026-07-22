import {
  clearAuthRateLimit,
  getAuthRateLimit,
  recordAuthRateLimitFailure,
  releaseAuthRateLimitVerification,
  reserveAuthRateLimitVerification,
} from './db';
import { HttpError } from './http';
import type { Env } from './types';

const encoder = new TextEncoder();
const MAX_BACKOFF_SECONDS = 8;
const RESERVATION_SECONDS = 30;

export interface AuthRateLimitPolicy {
  maxFailures: number;
  windowSeconds: number;
  now?: () => number;
  clientIp?: string;
}

export interface AuthRateLimitContext {
  readonly db: D1Database;
  readonly keyHash: string;
  readonly scope: string;
  readonly reservationToken: string;
  readonly policy: AuthRateLimitPolicy;
}

export interface AuthRateLimitAttempt {
  readonly scope: string;
  readonly subject: string;
  readonly policy: AuthRateLimitPolicy;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedSubject(subject: string): string {
  return subject.normalize('NFKC').trim().toLowerCase();
}

function clientIp(request: Request, policy: AuthRateLimitPolicy): string {
  const cloudflareIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cloudflareIp) return cloudflareIp;
  if (policy.clientIp?.trim()) return policy.clientIp.trim();
  throw new HttpError(500, 'AUTH_CLIENT_IP_UNAVAILABLE', 'Authentication client identity is unavailable');
}

function nowSeconds(policy: AuthRateLimitPolicy): number {
  const value = policy.now ? policy.now() : Date.now() / 1000;
  return Math.floor(value);
}

function validatePolicy(policy: AuthRateLimitPolicy): void {
  if (!Number.isInteger(policy.maxFailures) || policy.maxFailures < 1
    || !Number.isInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
    throw new Error('Invalid authentication rate-limit policy');
  }
}

async function rateLimitKey(env: Env, scope: string, ip: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const identity = JSON.stringify([scope, ip, normalizedSubject(subject)]);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(identity)));
}

function reservationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rateLimited(retryAfter: number): HttpError {
  return new HttpError(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts', {
    retryAfter: Math.max(1, Math.ceil(retryAfter)),
  });
}

export async function assertAuthAllowed(
  env: Env,
  request: Request,
  scope: string,
  subject: string,
  policy: AuthRateLimitPolicy,
): Promise<AuthRateLimitContext> {
  validatePolicy(policy);
  const keyHash = await rateLimitKey(env, scope, clientIp(request, policy), subject);
  const now = nowSeconds(policy);
  const token = reservationToken();
  const reserved = await reserveAuthRateLimitVerification(
    env.DB,
    keyHash,
    scope,
    token,
    now,
    policy.windowSeconds,
    policy.maxFailures,
    RESERVATION_SECONDS,
  );
  if (reserved) {
    return { db: env.DB, keyHash, scope, reservationToken: token, policy };
  }

  const state = await getAuthRateLimit(env.DB, keyHash);
  if (!state) throw rateLimited(1);
  const windowEndsAt = state.window_started_at + policy.windowSeconds;
  const thresholdBlockedUntil = state.failure_count >= policy.maxFailures ? windowEndsAt : 0;
  const retryAt = Math.max(state.blocked_until, thresholdBlockedUntil, state.reservation_expires_at);
  throw rateLimited(Math.max(1, retryAt - now));
}

/**
 * Acquires related verification leases in one stable order. Each reservation is
 * independent, so a failed later acquisition must release earlier leases.
 */
export async function assertAuthAllowedAll(
  env: Env,
  request: Request,
  attempts: readonly AuthRateLimitAttempt[],
): Promise<AuthRateLimitContext[]> {
  if (attempts.length === 0) throw new Error('At least one authentication rate-limit attempt is required');

  const contexts: AuthRateLimitContext[] = [];
  try {
    for (const attempt of attempts) {
      contexts.push(await assertAuthAllowed(env, request, attempt.scope, attempt.subject, attempt.policy));
    }
    return contexts;
  } catch (error) {
    await Promise.all(contexts.map((context) => releaseAuthReservationSafely(context)));
    throw error;
  }
}

export async function recordAuthFailure(context: AuthRateLimitContext): Promise<number> {
  const now = nowSeconds(context.policy);
  return recordAuthRateLimitFailure(
    context.db,
    context.keyHash,
    context.scope,
    context.reservationToken,
    now,
    context.policy.windowSeconds,
    MAX_BACKOFF_SECONDS,
  );
}

export function clearAuthFailures(context: AuthRateLimitContext): Promise<boolean> {
  return clearAuthRateLimit(context.db, context.keyHash, context.reservationToken);
}

export function releaseAuthReservation(context: AuthRateLimitContext): Promise<boolean> {
  return releaseAuthRateLimitVerification(context.db, context.keyHash, context.reservationToken);
}

export async function releaseAuthReservationSafely(context: AuthRateLimitContext): Promise<void> {
  try {
    await releaseAuthReservation(context);
  } catch {
    // Preserve the original authentication error if cleanup storage is unavailable.
  }
}

export async function recordAuthFailures(contexts: readonly AuthRateLimitContext[]): Promise<void> {
  let index = 0;
  try {
    for (; index < contexts.length; index += 1) await recordAuthFailure(contexts[index]);
  } catch (error) {
    await Promise.all(contexts.slice(index).map((context) => releaseAuthReservationSafely(context)));
    throw error;
  }
}

export async function clearAuthFailureContexts(contexts: readonly AuthRateLimitContext[]): Promise<boolean> {
  let index = 0;
  try {
    for (; index < contexts.length; index += 1) {
      if (!await clearAuthFailures(contexts[index])) return false;
    }
    return true;
  } finally {
    await Promise.all(contexts.slice(index).map((context) => releaseAuthReservationSafely(context)));
  }
}

export async function releaseAuthReservationsSafely(contexts: readonly AuthRateLimitContext[]): Promise<void> {
  await Promise.all(contexts.map((context) => releaseAuthReservationSafely(context)));
}
