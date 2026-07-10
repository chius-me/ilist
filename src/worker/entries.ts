import { getChildByName, getEntryById, listAncestorRows, listChildRows, listDescendantRows } from './db';
import { encodeVirtualPath, normalizeVirtualPath } from './entry-domain';
import { HttpError } from './http';
import type { Breadcrumb, DirectoryResponse, Entry, EntryCapabilities, EntryRow } from './types';

export async function isEffectivelyPublic(db: D1Database, id: string): Promise<boolean> {
  const rows = await listAncestorRows(db, id);
  return rows.length > 0 && rows.every((row) => row.status === 'ready' && row.is_public === 1);
}

function capabilities(row: EntryRow, admin: boolean): EntryCapabilities {
  const file = row.kind === 'file';
  return {
    open: row.kind === 'folder',
    preview: file,
    download: file,
    rename: admin && row.id !== 'root',
    move: admin && row.id !== 'root',
    delete: admin && row.id !== 'root',
    changeVisibility: admin && row.id !== 'root',
  };
}

export function entryToApi(row: EntryRow, admin: boolean, effectivePublic: boolean): Entry {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    size: row.size,
    contentType: row.content_type,
    updatedAt: row.updated_at,
    isPublic: row.is_public === 1,
    effectivePublic,
    sortOrder: row.sort_order,
    description: row.description,
    capabilities: capabilities(row, admin),
  };
}

export async function resolveEntryPath(db: D1Database, pathname: string, admin: boolean): Promise<EntryRow> {
  const { segments } = normalizeVirtualPath(pathname);
  let current = await getEntryById(db, 'root');
  if (!current) throw new HttpError(500, 'ROOT_ENTRY_MISSING', 'Root entry is missing');
  for (const segment of segments) {
    current = await getChildByName(db, current.id, segment);
    if (!current || current.status !== 'ready' || (!admin && current.is_public !== 1)) {
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    }
  }
  if (!admin && !(await isEffectivelyPublic(db, current.id))) {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  }
  return current;
}

export async function breadcrumbsFor(db: D1Database, id: string): Promise<Breadcrumb[]> {
  const rows = (await listAncestorRows(db, id)).reverse();
  const segments: string[] = [];
  return rows.map((row) => {
    if (row.id !== 'root') segments.push(row.name);
    return { id: row.id, name: row.id === 'root' ? 'ilist' : row.name, path: encodeVirtualPath(segments) };
  });
}

export async function listDirectory(db: D1Database, pathname: string, admin: boolean): Promise<DirectoryResponse> {
  const current = await resolveEntryPath(db, pathname, admin);
  if (current.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'Entry is not a folder');
  const rows = await listChildRows(db, current.id);
  const visible = admin ? rows : rows.filter((row) => row.is_public === 1);
  return {
    current: entryToApi(current, admin, await isEffectivelyPublic(db, current.id)),
    breadcrumbs: await breadcrumbsFor(db, current.id),
    items: await Promise.all(visible.map(async (row) => entryToApi(row, admin, await isEffectivelyPublic(db, row.id)))),
  };
}

export async function listDescendants(db: D1Database, id: string): Promise<EntryRow[]> {
  return listDescendantRows(db, id);
}
