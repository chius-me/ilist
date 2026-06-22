import {
  clearAuthRateLimit,
  getAuthRateLimit,
  recordAuthRateLimitFailure,
} from './db';
import { HttpError } from './http';
import type { Env } from './types';

const encoder = new TextEncoder();
const MAX_BACKOFF_SECONDS = 8;

export interface AuthRateLimitPolicy {
  maxFailures: number;
  windowSeconds: number;
  now?: () => number;
}

export interface AuthRateLimitContext {
  readonly db: D1Database;
  readonly keyHash: string;
  readonly scope: string;
  readonly policy: AuthRateLimitPolicy;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedSubject(subject: string): string {
  return subject.normalize('NFKC').trim().toLowerCase();
}

function clientIp(env: Env, request: Request): string {
  const cloudflareIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cloudflareIp) return cloudflareIp;
  if (env.AUTH_RATE_LIMIT_TEST_CLIENT_IP) return env.AUTH_RATE_LIMIT_TEST_CLIENT_IP;
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
  const keyHash = await rateLimitKey(env, scope, clientIp(env, request), subject);
  const context = { db: env.DB, keyHash, scope, policy };
  const state = await getAuthRateLimit(env.DB, keyHash);
  if (!state) return context;

  const now = nowSeconds(policy);
  const windowEndsAt = state.window_started_at + policy.windowSeconds;
  if (now >= windowEndsAt) return context;

  const thresholdBlockedUntil = state.failure_count >= policy.maxFailures ? windowEndsAt : 0;
  const retryAt = Math.max(state.blocked_until, thresholdBlockedUntil);
  if (now < retryAt) throw rateLimited(retryAt - now);
  return context;
}

export async function recordAuthFailure(context: AuthRateLimitContext): Promise<number> {
  const now = nowSeconds(context.policy);
  return recordAuthRateLimitFailure(
    context.db,
    context.keyHash,
    context.scope,
    now,
    context.policy.windowSeconds,
    MAX_BACKOFF_SECONDS,
  );
}

export async function clearAuthFailures(context: AuthRateLimitContext): Promise<void> {
  await clearAuthRateLimit(context.db, context.keyHash);
}
