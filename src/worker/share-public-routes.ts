import { sha256Hex, verifyPassword } from './auth';
import {
  assertAuthAllowed,
  clearAuthFailures,
  recordAuthFailure,
  type AuthRateLimitPolicy,
} from './auth-rate-limit';
import { HttpError, ok, readJson, requireSameOriginWhenPresent } from './http';
import {
  createShareAuthorization,
  hasShareAuthorization,
  shareAuthorizationCookie,
} from './share-auth';
import { getShareByTokenHash } from './share-store';
import { downloadSharedFile, listSharedFolder, resolveSharedItem } from './share-targets';
import type { Env, Share } from './types';

const SHARE_AUTH_TTL_SECONDS = 60 * 60;
const MAX_PASSWORD_BYTES = 256;

export interface SharePublicRouteOptions {
  now?: () => number;
  verifyPassword?: typeof verifyPassword;
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405 });
}

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function shareNotFound(): HttpError {
  return new HttpError(404, 'SHARE_NOT_FOUND', 'Share was not found');
}

async function activeShare(env: Env, token: string, now = Math.floor(Date.now() / 1000)): Promise<Share> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw shareNotFound();
  const share = await getShareByTokenHash(env.DB, await sha256Hex(token));
  if (!share) throw shareNotFound();
  if (!share.enabled) throw new HttpError(410, 'SHARE_DISABLED', 'Share is disabled');
  if (share.expiresAt !== null && share.expiresAt <= now) {
    throw new HttpError(410, 'SHARE_EXPIRED', 'Share has expired');
  }
  return share;
}

async function requirePasswordAuthorization(env: Env, request: Request, share: Share, token: string): Promise<void> {
  if (share.passwordHash === null) return;
  if (!await hasShareAuthorization(env, request, share.id, token)) {
    throw new HttpError(401, 'SHARE_PASSWORD_REQUIRED', 'Share password is required');
  }
}

async function authenticate(
  request: Request,
  env: Env,
  share: Share,
  token: string,
  options: SharePublicRouteOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  requireSameOriginWhenPresent(request);
  const policy: AuthRateLimitPolicy = { maxFailures: 10, windowSeconds: 60, now: options.now };
  const rateLimit = await assertAuthAllowed(env, request, 'share-password', share.id, policy);
  let body: { password?: unknown };
  try {
    body = await readJson<{ password?: unknown }>(request);
  } catch {
    await recordAuthFailure(rateLimit);
    throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
  }
  if (typeof body.password !== 'string'
    || new TextEncoder().encode(body.password).byteLength > MAX_PASSWORD_BYTES
    || share.passwordHash === null) {
    await recordAuthFailure(rateLimit);
    throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
  }
  if (!await (options.verifyPassword ?? verifyPassword)(body.password, share.passwordHash)) {
    await recordAuthFailure(rateLimit);
    throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
  }
  await clearAuthFailures(rateLimit);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(now + SHARE_AUTH_TTL_SECONDS, share.expiresAt ?? Number.MAX_SAFE_INTEGER);
  const authorization = await createShareAuthorization(env, share.id, expiresAt);
  return privateNoStore(ok({}, {
    headers: { 'set-cookie': await shareAuthorizationCookie(request, token, authorization, expiresAt, now) },
  }));
}

function decodePathValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'SHARE_ITEM_INVALID', 'Shared item is invalid');
  }
}

function normalizePublicError(error: unknown): never {
  if (error instanceof HttpError) {
    if (error.code.startsWith('SHARE_') || error.code === 'NOT_A_FOLDER' || error.code === 'NOT_A_FILE') throw error;
    if (error.status === 404) throw new HttpError(404, 'SHARE_TARGET_MISSING', 'Shared item is unavailable');
  }
  throw new HttpError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Shared storage is unavailable');
}

export async function handleSharePublicRoutes(
  request: Request,
  env: Env,
  url: URL,
  options: SharePublicRouteOptions = {},
): Promise<Response | null> {
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const token = decodePathValue(match[1]);
  const suffix = match[2] ?? '';
  if (suffix === '' || suffix === '/') return null;

  const share = await activeShare(env, token);
  if (suffix === '/auth') return authenticate(request, env, share, token, options);
  await requirePasswordAuthorization(env, request, share, token);

  try {
    if (suffix === '/api') {
      if (request.method !== 'GET') return methodNotAllowed();
      const root = await resolveSharedItem(env, share, null);
      return privateNoStore(ok({
        name: share.name,
        targetKind: share.targetKind,
        allowDownload: share.allowDownload,
        protected: share.passwordHash !== null,
        expiresAt: share.expiresAt === null ? null : new Date(share.expiresAt * 1000).toISOString(),
        entry: root.entry,
      }));
    }

    if (suffix === '/api/list') {
      if (request.method !== 'GET') return methodNotAllowed();
      const parent = url.searchParams.get('parent');
      return privateNoStore(ok(await listSharedFolder(env, share, parent || null)));
    }

    const entryMatch = /^\/api\/entries\/([^/]+)$/.exec(suffix);
    if (entryMatch) {
      if (request.method !== 'GET') return methodNotAllowed();
      return privateNoStore(ok((await resolveSharedItem(env, share, decodePathValue(entryMatch[1]))).entry));
    }

    const fileMatch = /^\/file\/([^/]+)\/[^/]+$/.exec(suffix);
    if (fileMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      const download = url.searchParams.get('download') === '1';
      if (download && !share.allowDownload) {
        throw new HttpError(403, 'SHARE_DOWNLOAD_DISABLED', 'Downloads are disabled for this share');
      }
      return privateNoStore(await downloadSharedFile(
        env,
        share,
        decodePathValue(fileMatch[1]),
        request,
        download,
      ));
    }
  } catch (error) {
    normalizePublicError(error);
  }

  throw shareNotFound();
}
