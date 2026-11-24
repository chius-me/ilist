import {
  clearSessionCookie,
  createSession,
  deleteSession,
  sessionCookie,
  verifyPassword,
  verifyPasswordDetailed,
} from '../auth';
import {
  assertAuthAllowedAll,
  assertGlobalAuthWindowAllowed,
  clearAuthFailureContexts,
  clearGlobalAuthFailures,
  recordAuthFailures,
  recordGlobalAuthFailure,
  releaseAuthReservationsSafely,
  type AuthRateLimitPolicy,
} from '../auth-rate-limit';
import { deleteAuthRateLimitsBefore } from '../db/rate-limits';
import { deleteExpiredSessions, listExpiredSessionIds } from '../db/sessions';
import { fail, HttpError, ok, readJson, requireSameOriginWhenPresent } from '../http';
import type { SharePublicRouteOptions } from '../share-public-routes';
import type { Env } from '../types';
import { abortUploadsForSession } from '../upload-service';

interface LoginBody {
  username?: string;
  password?: string;
}

export interface RouteRequestOptions {
  passwordAuthentication?: {
    now?: () => number;
    clientIp?: string;
    verifyPassword?: typeof verifyPassword;
    verifyPasswordDetailed?: typeof verifyPasswordDetailed;
    hashPassword?: SharePublicRouteOptions['hashPassword'];
    upgradeSharePasswordHash?: SharePublicRouteOptions['upgradeSharePasswordHash'];
  };
}

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

export async function cleanupExpiredSessions(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiredIds = await listExpiredSessionIds(env.DB, now, 100);
  for (const sessionId of expiredIds) {
    await abortUploadsForSession(env, sessionId);
  }
  await deleteExpiredSessions(env.DB, now, 100);
}

export async function handleLogin(request: Request, env: Env, options: RouteRequestOptions): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  requireSameOriginWhenPresent(request);

  const body = await readJson<LoginBody>(request);
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const expectedUsername = env.ADMIN_USERNAME || 'admin';
  const policy: AuthRateLimitPolicy = {
    maxFailures: 5,
    windowSeconds: 60,
    now: options.passwordAuthentication?.now,
    clientIp: options.passwordAuthentication?.clientIp,
  };
  const globalLimit = await assertGlobalAuthWindowAllowed(env, 'admin-login-global', {
    maxFailures: 30,
    windowSeconds: 300,
    now: options.passwordAuthentication?.now,
  });
  // The total-IP lease is first for every login, preventing arbitrary usernames
  // from multiplying expensive PBKDF2 work while retaining the user-specific key.
  const rateLimits = await assertAuthAllowedAll(env, request, [
    { scope: 'admin-login-ip', subject: 'all-usernames', policy },
    { scope: 'admin-login', subject: username, policy },
  ]);
  let reservationFinalized = false;
  try {
    const verification = options.passwordAuthentication?.verifyPasswordDetailed
      ? await options.passwordAuthentication.verifyPasswordDetailed(password, env.ADMIN_PASSWORD_HASH)
      : options.passwordAuthentication?.verifyPassword
        ? {
            valid: await options.passwordAuthentication.verifyPassword(password, env.ADMIN_PASSWORD_HASH),
            needsUpgrade: false,
          }
        : await verifyPasswordDetailed(password, env.ADMIN_PASSWORD_HASH);

    if (username !== expectedUsername || !verification.valid) {
      await recordAuthFailures(rateLimits);
      await recordGlobalAuthFailure(globalLimit);
      reservationFinalized = true;
      throw new HttpError(401, 'Invalid username or password');
    }

    if (!await clearAuthFailureContexts(rateLimits)) {
      throw new HttpError(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts', { retryAfter: 1 });
    }
    await clearGlobalAuthFailures(globalLimit);
    reservationFinalized = true;
    if (verification.needsUpgrade) {
      console.warn('ADMIN_PASSWORD_HASH uses the legacy PBKDF2 format; rotate it to pbkdf2-sha256:100000.');
    }
    await cleanupExpiredSessions(env);
    const now = Math.floor(options.passwordAuthentication?.now?.() ?? Date.now() / 1000);
    await deleteAuthRateLimitsBefore(env.DB, now - 24 * 60 * 60, 100);
    const session = await createSession(env);
    return ok(
      { username: expectedUsername },
      { headers: { 'set-cookie': sessionCookie(request, session.token, session.expiresAt) } },
    );
  } catch (error) {
    if (!reservationFinalized) await releaseAuthReservationsSafely(rateLimits);
    throw error;
  }
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  requireSameOriginWhenPresent(request);
  await deleteSession(env, request, {
    beforeDelete: (sessionId) => abortUploadsForSession(env, sessionId),
  });
  return ok({}, { headers: { 'set-cookie': clearSessionCookie(request) } });
}
