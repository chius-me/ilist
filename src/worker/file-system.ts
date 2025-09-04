import { getChildByName, getEntryById, insertEntry, listAncestorRows, updateEntryFields } from './db';
import { validateEntryName } from './entry-domain';
import { entryToApi, isEffectivelyPublic } from './entries';
import { HttpError } from './http';
import type { BatchResult, Entry } from './types';

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
  await insertEntry(db, row);
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
  await updateEntryFields(db, id, { ...patch, name });
  const updated = (await getEntryById(db, id))!;
  return entryToApi(updated, true, await isEffectivelyPublic(db, id));
}

export async function moveEntries(db: D1Database, ids: string[], destinationId: string): Promise<BatchResult> {
  const destination = await requireFolder(db, destinationId);
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    try {
      const row = await requireMutable(db, id);
      if (row.kind === 'folder') {
        const ancestorIds = new Set((await listAncestorRows(db, destination.id)).map((entry) => entry.id));
        if (ancestorIds.has(row.id)) throw new HttpError(400, 'INVALID_MOVE_TARGET', 'Folder cannot move into itself or a descendant');
      }
      await ensureNameAvailable(db, destination.id, row.name, row.id);
      await updateEntryFields(db, row.id, { parentId: destination.id });
      result.succeeded.push(row.id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'MOVE_FAILED', 'Move failed');
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
