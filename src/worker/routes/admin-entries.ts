import { LARGE_UPLOAD_THRESHOLD_BYTES } from '../drivers/types';
import { validateEntryName } from '../entry-domain';
import { externalEntry, requireExternalCapability, resolveExternalEntry } from '../external-entries';
import { decodeExternalId } from '../external-identity';
import { fail, HttpError, ok, readJson } from '../http';
import { touchMountUpdatedAt } from '../mounts';
import type { BatchFailure, BatchResult, Env } from '../types';

interface FolderBody {
  parentId?: unknown;
  name?: unknown;
}

interface PatchEntryBody {
  name?: unknown;
}

interface MoveEntriesBody {
  ids?: unknown;
  destinationId?: unknown;
}

interface DeleteEntriesBody {
  ids?: unknown;
}

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

function invalidRequest(): never {
  throw new HttpError(400, 'INVALID_REQUEST', 'Invalid request body');
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalidRequest();
  return value;
}

function operationFailure(id: string, error: unknown): BatchFailure {
  if (error instanceof HttpError) return { id, code: error.code, message: error.message };
  return { id, code: 'PROVIDER_OPERATION_FAILED', message: 'Storage provider operation failed' };
}

async function touchMounts(db: D1Database, mountIds: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(mountIds)].map((mountId) => touchMountUpdatedAt(db, mountId).catch(() => undefined)));
}

async function moveExternalEntries(env: Env, ids: string[], destinationId: string): Promise<BatchResult> {
  const destinationIdentity = decodeExternalId(destinationId);
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  const touchedMounts = new Set<string>();

  for (const id of new Set(ids)) {
    const identity = decodeExternalId(id);
    if (!identity || !destinationIdentity || identity.mountId !== destinationIdentity.mountId) {
      failed.push({ id, code: 'CROSS_MOUNT_MOVE_UNSUPPORTED', message: 'Entries cannot be moved between mounts' });
      continue;
    }
    try {
      const source = await resolveExternalEntry(env, id, true);
      if (!source) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      requireExternalCapability(source.driver, 'move');
      await source.driver.move(identity.itemId, destinationIdentity.itemId);
      succeeded.push(id);
      touchedMounts.add(source.mount.id);
    } catch (error) {
      failed.push(operationFailure(id, error));
    }
  }
  await touchMounts(env.DB, touchedMounts);
  return { succeeded, failed };
}

async function copyExternalEntries(env: Env, ids: string[], destinationId: string): Promise<BatchResult> {
  const destinationIdentity = decodeExternalId(destinationId);
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  const touchedMounts = new Set<string>();

  for (const id of new Set(ids)) {
    const identity = decodeExternalId(id);
    if (!identity || !destinationIdentity || identity.mountId !== destinationIdentity.mountId) {
      failed.push({ id, code: 'CROSS_MOUNT_COPY_UNSUPPORTED', message: 'Entries cannot be copied between mounts' });
      continue;
    }
    try {
      const source = await resolveExternalEntry(env, id, true);
      if (!source) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      requireExternalCapability(source.driver, 'copy');
      await source.driver.copy(identity.itemId, destinationIdentity.itemId);
      succeeded.push(id);
      touchedMounts.add(source.mount.id);
    } catch (error) {
      failed.push(operationFailure(id, error));
    }
  }
  await touchMounts(env.DB, touchedMounts);
  return { succeeded, failed };
}

async function deleteExternalEntries(env: Env, ids: string[]): Promise<BatchResult> {
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  const touchedMounts = new Set<string>();

  for (const id of new Set(ids)) {
    if (!decodeExternalId(id)) {
      failed.push({ id, code: 'ENTRY_NOT_FOUND', message: 'Entry not found' });
      continue;
    }
    try {
      const source = await resolveExternalEntry(env, id, true);
      if (!source) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      requireExternalCapability(source.driver, 'delete');
      await source.driver.remove(source.identity.itemId);
      succeeded.push(id);
      touchedMounts.add(source.mount.id);
    } catch (error) {
      failed.push(operationFailure(id, error));
    }
  }
  await touchMounts(env.DB, touchedMounts);
  return { succeeded, failed };
}

export async function handleAdminEntryRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/admin/folders') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<FolderBody>(request);
    if (typeof body.parentId !== 'string' || typeof body.name !== 'string') invalidRequest();
    const external = await resolveExternalEntry(env, body.parentId, true);
    if (!external) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Folder not found');
    requireExternalCapability(external.driver, 'createFolder');
    const created = await external.driver.createFolder(external.identity.itemId, validateEntryName(body.name));
    await touchMountUpdatedAt(env.DB, external.mount.id).catch(() => undefined);
    return ok(externalEntry(created, external.mount, external.driver, true));
  }

  const uploadMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (uploadMatch) {
    if (request.method !== 'PUT') return methodNotAllowed();
    try {
      decodeURIComponent(uploadMatch[1]!);
    } catch {
      invalidRequest();
    }
    const parentId = url.searchParams.get('parentId');
    const name = url.searchParams.get('name');
    if (parentId === null || name === null) invalidRequest();
    const external = await resolveExternalEntry(env, parentId, true);
    if (!external) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Folder not found');
    requireExternalCapability(external.driver, 'upload');
    if (!request.body) invalidRequest();
    const contentLength = request.headers.get('content-length');
    const declaredSize = contentLength && /^(0|[1-9][0-9]*)$/.test(contentLength) ? Number(contentLength) : null;
    if (
      declaredSize !== null
      && declaredSize >= LARGE_UPLOAD_THRESHOLD_BYTES
      && !external.driver.capabilities.has('multipartUpload')
    ) {
      throw new HttpError(
        400,
        'UPLOAD_SESSION_UNSUPPORTED',
        'Resumable upload is not supported for this folder',
      );
    }
    const uploaded = await external.driver.upload(
      external.identity.itemId,
      validateEntryName(name),
      request.body,
      request.headers.get('content-type'),
    );
    await touchMountUpdatedAt(env.DB, external.mount.id).catch(() => undefined);
    return ok(externalEntry(uploaded, external.mount, external.driver, true));
  }

  if (url.pathname === '/api/admin/entries/move') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<MoveEntriesBody>(request);
    if (typeof body.destinationId !== 'string') invalidRequest();
    return ok(await moveExternalEntries(env, stringArray(body.ids), body.destinationId));
  }

  if (url.pathname === '/api/admin/entries/copy') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<MoveEntriesBody>(request);
    if (typeof body.destinationId !== 'string') invalidRequest();
    return ok(await copyExternalEntries(env, stringArray(body.ids), body.destinationId));
  }

  if (url.pathname === '/api/admin/entries/delete') {
    if (request.method !== 'POST') return methodNotAllowed();
    const body = await readJson<DeleteEntriesBody>(request);
    return ok(await deleteExternalEntries(env, stringArray(body.ids)));
  }

  if (url.pathname === '/api/admin/entries/visibility') {
    if (request.method !== 'POST') return methodNotAllowed();
    throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'External entries do not support per-entry visibility');
  }

  const patchMatch = /^\/api\/admin\/entries\/([^/]+)$/.exec(url.pathname);
  if (patchMatch) {
    if (request.method !== 'PATCH') return methodNotAllowed();
    const body = await readJson<PatchEntryBody>(request);
    if (typeof body.name !== 'string') invalidRequest();
    let id: string;
    try {
      id = decodeURIComponent(patchMatch[1]!);
    } catch {
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    }
    const external = await resolveExternalEntry(env, id, true);
    if (!external) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    requireExternalCapability(external.driver, 'rename');
    const renamed = await external.driver.rename(external.identity.itemId, validateEntryName(body.name));
    await touchMountUpdatedAt(env.DB, external.mount.id).catch(() => undefined);
    return ok(externalEntry(renamed, external.mount, external.driver, true));
  }

  return null;
}
