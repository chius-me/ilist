import { hashPassword } from './auth';
import { HttpError, noContent, ok, readJson } from './http';
import { getMount } from './mounts';
import { createShareToken } from './share-crypto';
import {
  createShareRecord,
  deleteShareRecord,
  getShareById,
  listShares,
  updateShareRecord,
  type UpdateShareRecordInput,
} from './share-store';
import { resolveShareCreationTarget } from './share-targets';
import type { Env, Share } from './types';

const CREATE_KEYS = new Set(['entryId', 'password', 'expiresAt', 'allowDownload', 'enabled']);
const UPDATE_KEYS = new Set(['password', 'clearPassword', 'expiresAt', 'allowDownload', 'enabled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new HttpError(400, 'INVALID_SHARE_POLICY', message);
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid('Share policy contains unsupported fields');
}

function password(value: unknown, required = false): string | null {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024) {
    invalid('Share password must contain between 8 and 1024 characters');
  }
  return value;
}

function expiration(value: unknown, now = Math.floor(Date.now() / 1000)): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid('Share expiration must be an ISO date');
  const milliseconds = Date.parse(value);
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(seconds) || seconds <= now) {
    invalid('Share expiration must be in the future');
  }
  return seconds;
}

function publicOrigin(env: Env): string {
  let url: URL;
  try {
    url = new URL(env.PUBLIC_ORIGIN);
  } catch {
    throw new HttpError(500, 'PUBLIC_ORIGIN_INVALID', 'Public origin is invalid');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new HttpError(500, 'PUBLIC_ORIGIN_INVALID', 'Public origin is invalid');
  }
  return url.origin;
}

async function toAdminView(env: Env, share: Share) {
  const mount = await getMount(env.DB, share.mountId);
  return {
    id: share.id,
    mountId: share.mountId,
    mountName: mount?.name ?? 'Unavailable storage',
    name: share.name,
    targetKind: share.targetKind,
    protected: share.passwordHash !== null,
    expiresAt: share.expiresAt === null ? null : new Date(share.expiresAt * 1000).toISOString(),
    allowDownload: share.allowDownload,
    enabled: share.enabled,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
}

async function createShare(request: Request, env: Env): Promise<Response> {
  const body = await readJson<unknown>(request);
  if (!isRecord(body)) invalid('Share policy is invalid');
  assertKeys(body, CREATE_KEYS);
  if (typeof body.entryId !== 'string' || !body.entryId || typeof body.allowDownload !== 'boolean') {
    invalid('Share target and download policy are required');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') invalid('Share enabled state is invalid');
  const target = await resolveShareCreationTarget(env, body.entryId);
  const generated = createShareToken();
  const rawPassword = body.password === undefined ? null : password(body.password, true);
  const share = await createShareRecord(env.DB, {
    tokenHash: await generated.tokenHash,
    mountId: target.mountId,
    providerItemId: target.providerItemId,
    targetKind: target.targetKind,
    name: target.name,
    passwordHash: rawPassword === null ? null : await hashPassword(rawPassword),
    expiresAt: expiration(body.expiresAt),
    allowDownload: body.allowDownload,
    enabled: body.enabled !== false,
  });
  return ok({
    share: await toAdminView(env, share),
    url: `${publicOrigin(env)}/s/${generated.token}`,
  });
}

async function updateShare(request: Request, env: Env, id: string): Promise<Response> {
  const current = await getShareById(env.DB, id);
  if (!current) throw new HttpError(404, 'SHARE_NOT_FOUND', 'Share was not found');
  const body = await readJson<unknown>(request);
  if (!isRecord(body)) invalid('Share policy is invalid');
  assertKeys(body, UPDATE_KEYS);
  if (!Object.keys(body).length) invalid('Share policy update is empty');
  if (body.clearPassword !== undefined && typeof body.clearPassword !== 'boolean') invalid('Clear password state is invalid');
  if (body.password !== undefined && body.clearPassword === true) invalid('Password update is contradictory');
  if (body.allowDownload !== undefined && typeof body.allowDownload !== 'boolean') invalid('Download policy is invalid');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') invalid('Share enabled state is invalid');

  const patch: UpdateShareRecordInput = {};
  if (body.password !== undefined) patch.passwordHash = await hashPassword(password(body.password, true)!);
  if (body.clearPassword === true) patch.passwordHash = null;
  if (Object.prototype.hasOwnProperty.call(body, 'expiresAt')) patch.expiresAt = expiration(body.expiresAt);
  if (typeof body.allowDownload === 'boolean') patch.allowDownload = body.allowDownload;
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  const updated = await updateShareRecord(env.DB, id, patch);
  if (!updated) throw new HttpError(404, 'SHARE_NOT_FOUND', 'Share was not found');
  return ok(await toAdminView(env, updated));
}

export async function handleShareAdminRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/admin/shares') {
    if (request.method === 'GET') return ok(await Promise.all((await listShares(env.DB)).map((share) => toAdminView(env, share))));
    if (request.method === 'POST') return createShare(request, env);
    return new Response(null, { status: 405 });
  }

  const match = /^\/api\/admin\/shares\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(404, 'SHARE_NOT_FOUND', 'Share was not found');
  }
  if (request.method === 'PATCH') return updateShare(request, env, id);
  if (request.method === 'DELETE') {
    if (!await deleteShareRecord(env.DB, id)) throw new HttpError(404, 'SHARE_NOT_FOUND', 'Share was not found');
    return noContent();
  }
  return new Response(null, { status: 405 });
}
