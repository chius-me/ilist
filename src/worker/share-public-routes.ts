import {
  hashPassword,
  sha256Hex,
  verifyPassword,
  verifyPasswordDetailed,
  type PasswordVerification,
} from './auth';
import { PASSWORD_MAX_UTF8_BYTES } from '../../scripts/lib/password-policy.mjs';
import {
  assertAuthAllowed,
  clearAuthFailures,
  recordAuthFailure,
  releaseAuthReservationSafely,
  type AuthRateLimitPolicy,
} from './auth-rate-limit';
import { fail, HttpError, ok, readJson, requireSameOriginWhenPresent } from './http';
import {
  createShareAuthorization,
  hasShareAuthorization,
  shareAuthorizationCookie,
} from './share-auth';
import { canDownloadFromShare, isShareDownloadLimitReached } from './share-policy';
import {
  getShareByTokenHash,
  incrementShareAccessCount,
  refundShareDownload,
  tryConsumeShareDownload,
  upgradeSharePasswordHash,
} from './share-store';
import {
  downloadSharedFile,
  isAllowedInlinePreview,
  listSharedFolder,
  resolveSharedItem,
} from './share-targets';
import type { Env, Share } from './types';

const SHARE_AUTH_TTL_SECONDS = 60 * 60;
export interface SharePublicRouteOptions {
  now?: () => number;
  clientIp?: string;
  verifyPassword?: typeof verifyPassword;
  verifyPasswordDetailed?: typeof verifyPasswordDetailed;
  hashPassword?: typeof hashPassword;
  upgradeSharePasswordHash?: typeof upgradeSharePasswordHash;
}

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function shareNotFound(): HttpError {
  return new HttpError(404, 'SHARE_NOT_FOUND', 'Share was not found');
}

function currentUnixSeconds(options: SharePublicRouteOptions = {}): number {
  return Math.floor(options.now ? options.now() : Date.now() / 1000);
}

async function activeShare(env: Env, token: string, now: number): Promise<Share> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw shareNotFound();
  const share = await getShareByTokenHash(env.DB, await sha256Hex(token));
  if (!share) throw shareNotFound();
  if (!share.enabled) throw new HttpError(410, 'SHARE_DISABLED', 'Share is disabled');
  if (share.expiresAt !== null && share.expiresAt <= now) {
    throw new HttpError(410, 'SHARE_EXPIRED', 'Share has expired');
  }
  return share;
}

async function requirePasswordAuthorization(
  env: Env,
  request: Request,
  share: Share,
  token: string,
  now: number,
): Promise<void> {
  if (share.passwordHash === null) return;
  if (!await hasShareAuthorization(env, request, share.id, share.authRevision, token, now)) {
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
  const policy: AuthRateLimitPolicy = {
    maxFailures: 10,
    windowSeconds: 60,
    now: options.now,
    clientIp: options.clientIp,
  };
  const rateLimit = await assertAuthAllowed(env, request, 'share-password', share.id, policy);
  let reservationFinalized = false;
  try {
    let body: { password?: unknown };
    try {
      body = await readJson<{ password?: unknown }>(request);
    } catch {
      await recordAuthFailure(rateLimit);
      reservationFinalized = true;
      throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
    }
    if (typeof body.password !== 'string'
      || new TextEncoder().encode(body.password).byteLength > PASSWORD_MAX_UTF8_BYTES
      || share.passwordHash === null) {
      await recordAuthFailure(rateLimit);
      reservationFinalized = true;
      throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
    }
    let verification: PasswordVerification;
    if (options.verifyPasswordDetailed) {
      verification = await options.verifyPasswordDetailed(body.password, share.passwordHash);
    } else if (options.verifyPassword) {
      verification = {
        valid: await options.verifyPassword(body.password, share.passwordHash),
        needsUpgrade: false,
      };
    } else {
      verification = await verifyPasswordDetailed(body.password, share.passwordHash);
    }
    if (!verification.valid) {
      await recordAuthFailure(rateLimit);
      reservationFinalized = true;
      throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
    }
    if (verification.needsUpgrade) {
      const upgraded = await (options.hashPassword ?? hashPassword)(body.password);
      if (!await (options.upgradeSharePasswordHash ?? upgradeSharePasswordHash)(
        env.DB,
        share.id,
        share.passwordHash,
        upgraded,
      )) {
        throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Share password is invalid');
      }
    }
    if (!await clearAuthFailures(rateLimit)) {
      throw new HttpError(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts', { retryAfter: 1 });
    }
    reservationFinalized = true;
    const now = currentUnixSeconds(options);
    const expiresAt = Math.min(now + SHARE_AUTH_TTL_SECONDS, share.expiresAt ?? Number.MAX_SAFE_INTEGER);
    const authorization = await createShareAuthorization(env, share.id, share.authRevision, expiresAt);
    return privateNoStore(ok({}, {
      headers: { 'set-cookie': await shareAuthorizationCookie(request, token, authorization, expiresAt, now) },
    }));
  } catch (error) {
    if (!reservationFinalized) await releaseAuthReservationSafely(rateLimit);
    throw error;
  }
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
    if (
      error.code.startsWith('SHARE_')
      || error.code === 'NOT_A_FOLDER'
      || error.code === 'NOT_A_FILE'
      || error.code === 'RANGE_NOT_SATISFIABLE'
      || error.code === 'TEXT_PREVIEW_TOO_LARGE'
    ) {
      throw error;
    }
    if (error.status === 404) throw new HttpError(404, 'SHARE_TARGET_MISSING', 'Shared item is unavailable');
  }
  throw new HttpError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Shared storage is unavailable');
}

function shouldCountDownloadQuota(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const range = request.headers.get('range');
  if (!range) return true;
  return /^bytes=0-/i.test(range.trim());
}

function recordShareAccessCount(db: D1Database, shareId: string, ctx?: ExecutionContext): Promise<void> | void {
  const task = incrementShareAccessCount(db, shareId).catch(() => undefined);
  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  return task;
}

export async function handleSharePublicRoutes(
  request: Request,
  env: Env,
  url: URL,
  options: SharePublicRouteOptions = {},
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const token = decodePathValue(match[1]!);
  const suffix = match[2] ?? '';
  if (suffix === '' || suffix === '/') return null;

  const now = currentUnixSeconds(options);
  const share = await activeShare(env, token, now);
  if (suffix === '/auth') return authenticate(request, env, share, token, options);
  await requirePasswordAuthorization(env, request, share, token, now);

  try {
    if (suffix === '/api') {
      if (request.method !== 'GET') return methodNotAllowed();
      await recordShareAccessCount(env.DB, share.id, ctx);
      const root = await resolveSharedItem(env, share, null);
      return privateNoStore(ok({
        name: share.name,
        targetKind: share.targetKind,
        allowDownload: canDownloadFromShare(share),
        maxDownloads: share.maxDownloads,
        downloadCount: share.downloadCount,
        protected: share.passwordHash !== null,
        expiresAt: share.expiresAt === null ? null : new Date(share.expiresAt * 1000).toISOString(),
        entry: root.entry,
      }));
    }

    if (suffix === '/api/list') {
      if (request.method !== 'GET') return methodNotAllowed();
      await recordShareAccessCount(env.DB, share.id, ctx);
      const parent = url.searchParams.get('parent');
      return privateNoStore(ok(await listSharedFolder(env, share, parent || null)));
    }

    const entryMatch = /^\/api\/entries\/([^/]+)$/.exec(suffix);
    if (entryMatch) {
      if (request.method !== 'GET') return methodNotAllowed();
      await recordShareAccessCount(env.DB, share.id, ctx);
      return privateNoStore(ok((await resolveSharedItem(env, share, decodePathValue(entryMatch[1]!))).entry));
    }

    const fileMatch = /^\/file\/([^/]+)\/[^/]+$/.exec(suffix);
    if (fileMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      const download = url.searchParams.get('download') === '1';
      const sandboxedPreview = url.searchParams.get('preview') === '1';
      const requestedExport = url.searchParams.get('export');
      const itemHandle = decodePathValue(fileMatch[1]!);

      const resolved = await resolveSharedItem(env, share, itemHandle);
      if (resolved.item.kind !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Shared item is not a file');

      const exportOption = requestedExport
        ? resolved.item.exportOptions?.find((option) => option.format === requestedExport)
        : undefined;
      const previewAllowed = !download && isAllowedInlinePreview(resolved.item, exportOption, sandboxedPreview);

      let consumedQuota = false;
      if (download || !previewAllowed) {
        if (!share.allowDownload) {
          throw new HttpError(403, 'SHARE_DOWNLOAD_DISABLED', 'Downloads are disabled for this share');
        }
        if (shouldCountDownloadQuota(request)) {
          if (isShareDownloadLimitReached(share)) {
            throw new HttpError(403, 'SHARE_DOWNLOAD_LIMIT', 'Share download limit has been reached');
          }
          consumedQuota = await tryConsumeShareDownload(env.DB, share.id);
          if (!consumedQuota) {
            throw new HttpError(403, 'SHARE_DOWNLOAD_LIMIT', 'Share download limit has been reached');
          }
        }
      }

      try {
        return privateNoStore(await downloadSharedFile(
          env,
          share,
          resolved,
          request,
          download,
        ));
      } catch (error) {
        if (consumedQuota) {
          await refundShareDownload(env.DB, share.id).catch(() => undefined);
        }
        throw error;
      }
    }
  } catch (error) {
    normalizePublicError(error);
  }

  throw shareNotFound();
}
