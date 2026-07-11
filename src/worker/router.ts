import {
  clearSessionCookie,
  createSession,
  deleteSession,
  requireAdmin,
  sessionCookie,
  verifyPassword,
} from './auth';
import {
  deleteObjectIndex,
  getObject,
  LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS,
  listTree,
  normalizePrefix,
  normalizeStoredKey,
  patchObject,
  releaseLegacyObjectMutationReservation,
  renewLegacyObjectMutationReservation,
  rowToFileEntry,
  reserveLegacyObjectMutation,
  upsertObject,
} from './db';
import { fail, HttpError, noContent, ok, readJson } from './http';
import { keyFromPath, putObject, streamObject } from './r2';
import type { Env } from './types';

interface LoginBody {
  username?: string;
  password?: string;
}

interface PatchObjectBody {
  name?: string;
  description?: string;
  isPublic?: boolean;
  sortOrder?: number;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

export interface LegacyObjectMutationReservationTiming {
  now?: () => number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  setInterval?: (callback: () => void, delayMs: number) => unknown;
  clearInterval?: (interval: unknown) => void;
}

export interface RouteRequestOptions {
  legacyObjectMutationReservation?: LegacyObjectMutationReservationTiming;
}

interface LegacyObjectMutationGuard {
  renewBeforeIndexWrite(): Promise<void>;
}

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

async function withLegacyObjectMutationReservation<T>(
  env: Env,
  operation: (guard: LegacyObjectMutationGuard) => Promise<T>,
  timing: LegacyObjectMutationReservationTiming = {},
): Promise<T> {
  const now = timing.now || Date.now;
  const leaseDurationMs = timing.leaseDurationMs ?? LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS;
  const heartbeatIntervalMs = timing.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseDurationMs / 3));
  const reservation = await reserveLegacyObjectMutation(env.DB, undefined, now(), leaseDurationMs);
  if (!reservation) {
    throw new HttpError(503, 'Legacy object migration is in progress');
  }

  let ownershipLost = false;
  let stopped = false;
  let renewal: Promise<void> | undefined;
  const renew = async (): Promise<void> => {
    if (ownershipLost) return;
    try {
      if (!(await renewLegacyObjectMutationReservation(env.DB, reservation, now(), leaseDurationMs))) {
        ownershipLost = true;
      }
    } catch {
      ownershipLost = true;
    }
  };
  const heartbeat = () => {
    if (stopped || ownershipLost || renewal) return;
    renewal = renew().finally(() => {
      renewal = undefined;
    });
  };
  const setHeartbeatInterval = timing.setInterval || ((callback, delayMs) => setInterval(callback, delayMs));
  const clearHeartbeatInterval = timing.clearInterval || ((interval) => clearInterval(interval as number));
  const interval = setHeartbeatInterval(heartbeat, heartbeatIntervalMs);
  const guard: LegacyObjectMutationGuard = {
    async renewBeforeIndexWrite(): Promise<void> {
      await renewal;
      let renewed = false;
      try {
        renewed = await renewLegacyObjectMutationReservation(env.DB, reservation, now(), leaseDurationMs);
      } catch {
        ownershipLost = true;
      }
      if (ownershipLost || !renewed) {
        ownershipLost = true;
        throw new HttpError(503, 'Legacy object mutation reservation was lost');
      }
    },
  };

  try {
    return await operation(guard);
  } finally {
    stopped = true;
    clearHeartbeatInterval(interval);
    await renewal;
    await releaseLegacyObjectMutationReservation(env.DB, reservation);
  }
}

async function cleanupExpiredSessions(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now).run();
}

async function handlePublic(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed();

  if (url.pathname === '/api/public/tree') {
    const prefix = normalizePrefix(url.searchParams.get('prefix'));
    return ok(await listTree(env.DB, prefix, true));
  }

  if (url.pathname === '/api/public/object') {
    const rawKey = url.searchParams.get('key');
    if (!rawKey) throw new HttpError(400, 'Missing key');
    const row = await getObject(env.DB, normalizeStoredKey(rawKey), true);
    if (!row) throw new HttpError(404, 'Object not found');
    return ok(rowToFileEntry(row));
  }

  throw new HttpError(404, 'Not found');
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();

  const body = await readJson<LoginBody>(request);
  const username = body.username || '';
  const password = body.password || '';
  const expectedUsername = env.ADMIN_USERNAME || 'admin';

  if (username !== expectedUsername || !(await verifyPassword(password, env.ADMIN_PASSWORD_HASH))) {
    throw new HttpError(401, 'Invalid username or password');
  }

  await cleanupExpiredSessions(env);
  const session = await createSession(env);
  return ok(
    { username: expectedUsername },
    { headers: { 'set-cookie': sessionCookie(request, session.token, session.expiresAt) } },
  );
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  await deleteSession(env, request);
  return ok({}, { headers: { 'set-cookie': clearSessionCookie(request) } });
}

async function handleAdmin(request: Request, env: Env, url: URL, options: RouteRequestOptions): Promise<Response> {
  if (url.pathname === '/api/admin/login') return handleLogin(request, env);
  if (url.pathname === '/api/admin/logout') return handleLogout(request, env);

  const user = await requireAdmin(env, request);

  if (url.pathname === '/api/admin/me') {
    if (request.method !== 'GET') return methodNotAllowed();
    return ok(user);
  }

  if (url.pathname === '/api/admin/objects') {
    if (request.method !== 'GET') return methodNotAllowed();
    const prefix = normalizePrefix(url.searchParams.get('prefix'));
    return ok(await listTree(env.DB, prefix, false));
  }

  if (url.pathname.startsWith('/api/admin/objects/')) {
    const key = keyFromPath(url.pathname, '/api/admin/objects/');

    if (request.method === 'PUT') {
      return await withLegacyObjectMutationReservation(env, async (guard) => {
        const object = await putObject(env, key, request);
        const contentType = request.headers.get('content-type') || object.httpMetadata?.contentType || null;
        await guard.renewBeforeIndexWrite();
        const row = await upsertObject(env.DB, {
          key,
          size: object.size,
          etag: object.httpEtag || object.etag,
          contentType,
        });
        return ok(rowToFileEntry(row));
      }, options.legacyObjectMutationReservation);
    }

    if (request.method === 'DELETE') {
      return await withLegacyObjectMutationReservation(env, async (guard) => {
        await env.R2_BUCKET.delete(key);
        await guard.renewBeforeIndexWrite();
        await deleteObjectIndex(env.DB, key);
        return noContent();
      }, options.legacyObjectMutationReservation);
    }

    if (request.method === 'PATCH') {
      return await withLegacyObjectMutationReservation(env, async (guard) => {
        const body = await readJson<PatchObjectBody>(request);
        await guard.renewBeforeIndexWrite();
        const row = await patchObject(env.DB, key, {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          isPublic: typeof body.isPublic === 'boolean' ? body.isPublic : undefined,
          sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
        });
        if (!row) throw new HttpError(404, 'Object not found');
        return ok(rowToFileEntry(row));
      }, options.legacyObjectMutationReservation);
    }

    return methodNotAllowed();
  }

  throw new HttpError(404, 'Not found');
}

async function handleFile(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();

  const key = keyFromPath(url.pathname, '/file/');
  const row = await getObject(env.DB, key, true);
  if (!row) throw new HttpError(404, 'File not found');

  const response = await streamObject(env, row, request);
  if (request.method === 'HEAD') {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function routeRequest(request: Request, env: Env, options: RouteRequestOptions = {}): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return noContent(JSON_HEADERS);
  }

  try {
    if (url.pathname.startsWith('/api/public/')) {
      return withSecurityHeaders(await handlePublic(request, env, url));
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return withSecurityHeaders(await handleAdmin(request, env, url, options));
    }
    if (url.pathname.startsWith('/file/')) {
      return withSecurityHeaders(await handleFile(request, env, url));
    }

    return await env.ASSETS.fetch(request);
  } catch (error) {
    if (error instanceof HttpError) {
      return withSecurityHeaders(fail(error.status, error.message));
    }
    console.error(error);
    return withSecurityHeaders(fail(500, 'Internal server error'));
  }
}
