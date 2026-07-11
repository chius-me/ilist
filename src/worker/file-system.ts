import {
  deleteEntryRow,
  deleteUploadingEntry,
  finalizeUploadedEntry,
  getChildByName,
  getEntryById,
  insertEntry,
  listAncestorRows,
  listDescendantRows,
  updateEntryFields,
} from './db';
import { storageKeyForEntry, validateEntryName } from './entry-domain';
import { entryToApi, isEffectivelyPublic } from './entries';
import { HttpError } from './http';
import type { BatchResult, Entry, EntryRow, Env } from './types';

const ENTRY_NAME_UNIQUE_CONSTRAINT = 'UNIQUE constraint failed: entries.parent_id, entries.name';
const ENTRY_ID_UNIQUE_CONSTRAINT = 'UNIQUE constraint failed: entries.id';

function hasUniqueConstraint(error: unknown, constraint: string): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { message?: unknown; cause?: unknown };
    if (typeof value.message === 'string' && value.message.includes(constraint)) return true;
    current = value.cause;
  }
  return false;
}

function entryNameConflict(error: unknown, name: string): HttpError | null {
  return hasUniqueConstraint(error, ENTRY_NAME_UNIQUE_CONSTRAINT)
    ? new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name', { name })
    : null;
}

function entryIdConflict(error: unknown): boolean {
  return hasUniqueConstraint(error, ENTRY_ID_UNIQUE_CONSTRAINT);
}

function validateClientEntryId(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new HttpError(400, 'INVALID_ENTRY_ID', 'Invalid entry ID');
  }
  return id;
}

export async function requireFolder(db: D1Database, id: string) {
  const row = await getEntryById(db, id);
  if (!row || row.kind !== 'folder' || row.status !== 'ready') {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Folder not found');
  }
  return row;
}

export async function requireMutable(db: D1Database, id: string) {
  const row = await getEntryById(db, id);
  if (!row || row.status !== 'ready') throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  if (row.id === 'root') throw new HttpError(400, 'ROOT_ENTRY_IMMUTABLE', 'Root entry cannot be changed');
  return row;
}

export async function ensureNameAvailable(db: D1Database, parentId: string, name: string, exceptId?: string): Promise<void> {
  const existing = await getChildByName(db, parentId, name);
  if (existing && existing.id !== exceptId) {
    throw new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name', { name });
  }
}

export async function createFolder(db: D1Database, input: { parentId: string; name: string }): Promise<Entry> {
  const parent = await requireFolder(db, input.parentId);
  const name = validateEntryName(input.name, parent.id === 'root');
  await ensureNameAvailable(db, parent.id, name);
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(), parent_id: parent.id, name, kind: 'folder' as const,
    storage_key: null, size: 0, content_type: null, etag: null, status: 'ready' as const,
    is_public: parent.is_public, sort_order: 0, description: '', created_at: now, updated_at: now,
  };
  try {
    await insertEntry(db, row);
  } catch (error) {
    throw entryNameConflict(error, name) ?? error;
  }
  return entryToApi(row, true, await isEffectivelyPublic(db, row.id));
}

export async function patchEntry(
  db: D1Database,
  id: string,
  patch: { name?: string; description?: string; sortOrder?: number; isPublic?: boolean },
): Promise<Entry> {
  const row = await requireMutable(db, id);
  const name = patch.name === undefined ? undefined : validateEntryName(patch.name, row.parent_id === 'root');
  if (name) await ensureNameAvailable(db, row.parent_id!, name, row.id);
  try {
    await updateEntryFields(db, id, { ...patch, ...(name === undefined ? {} : { name }) });
  } catch (error) {
    throw entryNameConflict(error, name ?? row.name) ?? error;
  }
  const updated = (await getEntryById(db, id))!;
  return entryToApi(updated, true, await isEffectivelyPublic(db, id));
}

export async function moveEntries(db: D1Database, ids: string[], destinationId: string): Promise<BatchResult> {
  const destination = await requireFolder(db, destinationId);
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    let name = '';
    try {
      const row = await requireMutable(db, id);
      name = validateEntryName(row.name, destination.id === 'root');
      if (row.kind === 'folder') {
        const ancestorIds = new Set((await listAncestorRows(db, destination.id)).map((entry) => entry.id));
        if (ancestorIds.has(row.id)) throw new HttpError(400, 'INVALID_MOVE_TARGET', 'Folder cannot move into itself or a descendant');
      }
      await ensureNameAvailable(db, destination.id, name, row.id);
      await updateEntryFields(db, row.id, { parentId: destination.id });
      result.succeeded.push(row.id);
    } catch (error) {
      const known = error instanceof HttpError ? error : entryNameConflict(error, name) ?? new HttpError(500, 'MOVE_FAILED', 'Move failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }
  return result;
}

export async function setEntriesVisibility(db: D1Database, ids: string[], isPublic: boolean): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    try {
      await requireMutable(db, id);
      await updateEntryFields(db, id, { isPublic });
      result.succeeded.push(id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'VISIBILITY_UPDATE_FAILED', 'Visibility update failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }
  return result;
}

export async function uploadFile(
  env: Env,
  request: Request,
  input: { id: string; parentId: string; name: string },
): Promise<Entry> {
  if (!request.body) throw new HttpError(400, 'UPLOAD_BODY_MISSING', 'Upload body is missing');

  const id = validateClientEntryId(input.id);
  const parent = await requireFolder(env.DB, input.parentId);
  const name = validateEntryName(input.name, parent.id === 'root');
  const existing = await getEntryById(env.DB, id);
  if (existing) {
    if (existing.status === 'uploading') {
      throw new HttpError(409, 'UPLOAD_IN_PROGRESS', 'An upload for this entry ID is already in progress');
    }
    throw new HttpError(409, 'ENTRY_ID_CONFLICT', 'Upload ID already exists');
  }

  await ensureNameAvailable(env.DB, parent.id, name);
  const now = new Date().toISOString();
  const row: EntryRow = {
    id,
    parent_id: parent.id,
    name,
    kind: 'file',
    storage_key: storageKeyForEntry(id),
    size: 0,
    content_type: request.headers.get('content-type'),
    etag: null,
    status: 'uploading',
    is_public: parent.is_public,
    sort_order: 0,
    description: '',
    created_at: now,
    updated_at: now,
  };

  try {
    await insertEntry(env.DB, row);
  } catch (error) {
    if (entryIdConflict(error)) {
      const concurrent = await getEntryById(env.DB, id);
      if (concurrent?.status === 'uploading') {
        throw new HttpError(409, 'UPLOAD_IN_PROGRESS', 'An upload for this entry ID is already in progress');
      }
      throw new HttpError(409, 'ENTRY_ID_CONFLICT', 'Upload ID already exists');
    }
    throw entryNameConflict(error, name) ?? error;
  }

  try {
    const object = await env.R2_BUCKET.put(row.storage_key!, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
    });
    const finalized = await finalizeUploadedEntry(env.DB, id, {
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? request.headers.get('content-type'),
      etag: object.httpEtag || object.etag,
    });
    if (!finalized) throw new Error('Upload entry was not available for finalization');
  } catch (error) {
    await env.R2_BUCKET.delete(row.storage_key!).catch(() => undefined);
    await deleteUploadingEntry(env.DB, id).catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Upload failed');
  }

  const ready = await getEntryById(env.DB, id);
  if (!ready || ready.status !== 'ready') throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Upload finalization failed');
  return entryToApi(ready, true, await isEffectivelyPublic(env.DB, id));
}

export async function deleteEntryTrees(
  env: Env,
  ids: string[],
  options: { maxEntries?: number; deleteBlob?: (key: string) => Promise<void> } = {},
): Promise<BatchResult> {
  const maxEntries = options.maxEntries ?? 1000;
  const deleteBlob = options.deleteBlob ?? ((key) => env.R2_BUCKET.delete(key));
  const result: BatchResult = { succeeded: [], failed: [] };

  for (const id of [...new Set(ids)]) {
    try {
      const target = await getEntryById(env.DB, id);
      if (!target || target.id === 'root' || !['ready', 'deleting'].includes(target.status)) {
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }

      const rows = await listDescendantRows(env.DB, id);
      if (rows.length > maxEntries) {
        throw new HttpError(409, 'OPERATION_LIMIT_EXCEEDED', 'Delete contains too many entries');
      }

      for (const row of rows) {
        if (row.status === 'ready') await updateEntryFields(env.DB, row.id, { status: 'deleting' });
      }

      const failedFiles = new Set<string>();
      for (const row of rows.filter((entry) => entry.kind === 'file')) {
        try {
          await deleteBlob(row.storage_key!);
        } catch {
          failedFiles.add(row.id);
        }
      }

      const keep = new Set<string>(failedFiles);
      for (const failedId of failedFiles) {
        for (const ancestor of await listAncestorRows(env.DB, failedId)) keep.add(ancestor.id);
      }

      for (const row of [...rows].reverse()) {
        if (keep.has(row.id)) await updateEntryFields(env.DB, row.id, { status: 'ready' });
        else await deleteEntryRow(env.DB, row.id);
      }

      if (failedFiles.size) {
        throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Some file contents could not be deleted');
      }
      result.succeeded.push(id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'DELETE_FAILED', 'Delete failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }

  return result;
}
