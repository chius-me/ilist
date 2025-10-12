import {
  clearSessionCookie,
  createSession,
  currentUser,
  deleteSession,
  requireAdmin,
  sessionCookie,
  verifyPassword,
} from './auth';
import {
  deleteObjectIndex,
  findEntryByStorageKey,
  getObject,
  getEntryById,
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
import { entryToApi, isEffectivelyPublic } from './entries';
import {
  createFolder,
  deleteEntryTrees,
  listVirtualDirectory,
  moveEntries,
  patchEntry,
  reconcileStorageRecovery,
  setEntriesVisibility,
  uploadFile,
} from './file-system';
import { fail, HttpError, noContent, ok, readJson, requireSameOrigin, requireSameOriginWhenPresent } from './http';
import { handleMountRoutes } from './mount-routes';
import { keyFromPath, putObject, streamEntryObject } from './r2';
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

interface FolderBody {
  parentId?: unknown;
  name?: unknown;
}

interface PatchEntryBody {
  name?: unknown;
  description?: unknown;
  sortOrder?: unknown;
  isPublic?: unknown;
}

interface MoveEntriesBody {
  ids?: unknown;
  destinationId?: unknown;
}

interface DeleteEntriesBody {
  ids?: unknown;
}

interface VisibilityBody {
  ids?: unknown;
  isPublic?: unknown;
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

function invalidRequest(): never {
  throw new HttpError(400, 'INVALID_REQUEST', 'Invalid request body');
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalidRequest();
  return value;
}

async function authorizeEntry(env: Env, id: string, admin: boolean) {
  const entry = await getEntryById(env.DB, id);
  if (!entry || entry.status !== 'ready') throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  const effectivePublic = await isEffectivelyPublic(env.DB, entry.id);
  if (!admin && !effectivePublic) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  return { entry, effectivePublic };
}

async function reconcileAfterStorageFailure(env: Env, operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError && error.code === 'STORAGE_OPERATION_FAILED') {
      await reconcileStorageRecovery(env, { limit: 1 }).catch(() => undefined);
    }
    throw error;
  }
}

async function handleFilesystem(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed();
  const admin = Boolean(await currentUser(env, request));

  if (url.pathname === '/api/fs/list') {
    return ok(await listVirtualDirectory(env.DB, url.searchParams.get('path') ?? '/', admin));
  }

  const match = /^\/api\/fs\/entries\/(.+)$/.exec(url.pathname);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    }
    const { entry, effectivePublic } = await authorizeEntry(env, id, admin);
    return ok(entryToApi(entry, admin, effectivePublic));
  }

  throw new HttpError(404, 'Not found');
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  requireSameOriginWhenPresent(request);

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
  requireSameOriginWhenPresent(request);
  await deleteSession(env, request);
  return ok({}, { headers: { 'set-cookie': clearSessionCookie(request) } });
}

async function handleAdmin(request: Request, env: Env, url: URL, options: RouteRequestOptions): Promise<Response> {
  if (url.pathname === '/api/admin/login') return handleLogin(request, env);
  if (url.pathname === '/api/admin/logout') return handleLogout(request, env);

  const user = await requireAdmin(env, request);
  if (request.method !== 'GET') requireSameOrigin(request);

  if (url.pathname === '/api/admin/me') {
    if (request.method !== 'GET') return methodNotAllowed();
    return ok(user);
  }

  const mountResponse = await handleMountRoutes(request, env, url);
  if (mountResponse) return mountResponse;

  if (url.pathname === '/api/admin/objects') {
    if (request.method !== 'GET') return methodNotAllowed();
    const prefix = normalizePrefix(url.searchParams.get('prefix'));
    return ok(await listTree(env.DB, prefix, false));
  }

  if (url.pathname === '/api/admin/folders') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<FolderBody>(request);
    if (typeof body.parentId !== 'string' || typeof body.name !== 'string') invalidRequest();
    return ok(await createFolder(env.DB, { parentId: body.parentId, name: body.name }));
  }

  const uploadMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (uploadMatch) {
    if (request.method !== 'PUT') return methodNotAllowed();
    let id: string;
    try {
      id = decodeURIComponent(uploadMatch[1]);
    } catch {
      throw new HttpError(400, 'INVALID_REQUEST', 'Invalid request body');
    }
    const parentId = url.searchParams.get('parentId');
    const name = url.searchParams.get('name');
    if (parentId === null || name === null) invalidRequest();
    return reconcileAfterStorageFailure(env, async () => ok(await uploadFile(env, request, { id, parentId, name })));
  }

  if (url.pathname === '/api/admin/entries/move') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<MoveEntriesBody>(request);
    if (typeof body.destinationId !== 'string') invalidRequest();
    return ok(await moveEntries(env.DB, stringArray(body.ids), body.destinationId));
  }

  if (url.pathname === '/api/admin/entries/delete') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<DeleteEntriesBody>(request);
    return reconcileAfterStorageFailure(env, async () => ok(await deleteEntryTrees(env, stringArray(body.ids))));
  }

  if (url.pathname === '/api/admin/entries/visibility') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<VisibilityBody>(request);
    if (typeof body.isPublic !== 'boolean') invalidRequest();
    return ok(await setEntriesVisibility(env.DB, stringArray(body.ids), body.isPublic));
  }

  const patchMatch = /^\/api\/admin\/entries\/([^/]+)$/.exec(url.pathname);
  if (patchMatch) {
    if (request.method !== 'PATCH') return methodNotAllowed();
    const body = await readJson<PatchEntryBody>(request);
    if (
      (body.name !== undefined && typeof body.name !== 'string')
      || (body.description !== undefined && typeof body.description !== 'string')
      || (body.sortOrder !== undefined && typeof body.sortOrder !== 'number')
      || (body.isPublic !== undefined && typeof body.isPublic !== 'boolean')
    ) invalidRequest();
    return ok(await patchEntry(env.DB, decodeURIComponent(patchMatch[1]), {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.sortOrder === 'number' ? { sortOrder: body.sortOrder } : {}),
      ...(typeof body.isPublic === 'boolean' ? { isPublic: body.isPublic } : {}),
    }));
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

  let suffix: string;
  try {
    suffix = decodeURIComponent(url.pathname.slice('/file/'.length));
  } catch {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  }
  const [candidateId] = suffix.split('/');
  const admin = Boolean(await currentUser(env, request));
  if (/^[A-Za-z0-9_-]{8,80}$/.test(candidateId) && await getEntryById(env.DB, candidateId)) {
    const { entry, effectivePublic } = await authorizeEntry(env, candidateId, admin);
    return streamEntryObject(env.R2_BUCKET, entry, request, {
      download: url.searchParams.get('download') === '1',
      publicFile: effectivePublic,
    });
  }

  const key = keyFromPath(url.pathname, '/file/');
  const legacy = await getObject(env.DB, key, false);
  if (!legacy) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  const entry = await findEntryByStorageKey(env.DB, legacy.key);
  if (!entry) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  await authorizeEntry(env, entry.id, admin);
  return new Response(null, { status: 302, headers: { location: `/file/${entry.id}/${encodeURIComponent(entry.name)}` } });
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
    if (url.pathname.startsWith('/api/fs/')) {
      return withSecurityHeaders(await handleFilesystem(request, env, url));
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
      return withSecurityHeaders(fail(error.status, error.code, error.message, error.details));
    }
    console.error(error);
    return withSecurityHeaders(fail(500, 'Internal server error'));
  }
}
