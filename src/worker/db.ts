import type { DirectoryEntry, FileEntry, ObjectRow, TreeResponse } from './types';

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function normalizePrefix(input: string | null | undefined): string {
  const normalized = normalizeSlash(input || '').replace(/^\/+/, '');
  if (!normalized || normalized === '/') return '';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function cleanKey(input: string): string {
  const normalized = normalizeSlash(input).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.includes('../') || normalized === '..') {
    throw new Error('Invalid object key');
  }
  if (/[\u0000-\u001f]/.test(normalized)) {
    throw new Error('Invalid object key');
  }
  return normalized;
}

export function normalizeKey(input: string): string {
  return cleanKey(decodeURIComponent(input));
}

export function normalizeStoredKey(input: string): string {
  return cleanKey(input);
}

export function fileNameFromKey(key: string): string {
  return key.split('/').filter(Boolean).pop() || key;
}

function toFileEntry(row: ObjectRow): FileEntry {
  return {
    key: row.key,
    name: row.name,
    size: row.size,
    contentType: row.content_type,
    etag: row.etag,
    updatedAt: row.updated_at,
    isPublic: row.is_public === 1,
    sortOrder: row.sort_order,
    description: row.description,
    type: 'file',
  };
}

function buildTree(prefix: string, rows: ObjectRow[]): TreeResponse {
  const directoryMap = new Map<string, DirectoryEntry>();
  const files: FileEntry[] = [];

  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    const rest = row.key.slice(prefix.length);
    if (!rest) continue;

    const slashIndex = rest.indexOf('/');
    if (slashIndex >= 0) {
      const name = rest.slice(0, slashIndex);
      const key = `${prefix}${name}/`;
      if (!directoryMap.has(key)) {
        directoryMap.set(key, { name, key, type: 'directory' });
      }
      continue;
    }

    files.push(toFileEntry(row));
  }

  return {
    prefix,
    directories: [...directoryMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: files.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  };
}

async function listRows(db: D1Database, prefix: string, publicOnly: boolean): Promise<ObjectRow[]> {
  const lower = prefix;
  const upper = `${prefix}\uffff`;
  const query = publicOnly
    ? `SELECT * FROM objects WHERE is_public = 1 AND key >= ? AND key < ? ORDER BY sort_order ASC, name ASC`
    : `SELECT * FROM objects WHERE key >= ? AND key < ? ORDER BY sort_order ASC, name ASC`;
  const result = await db.prepare(query).bind(lower, upper).all<ObjectRow>();
  return result.results || [];
}

export async function listTree(db: D1Database, prefix: string, publicOnly: boolean): Promise<TreeResponse> {
  return buildTree(prefix, await listRows(db, prefix, publicOnly));
}

export async function getObject(db: D1Database, key: string, publicOnly: boolean): Promise<ObjectRow | null> {
  const query = publicOnly
    ? `SELECT * FROM objects WHERE key = ? AND is_public = 1`
    : `SELECT * FROM objects WHERE key = ?`;
  return await db.prepare(query).bind(key).first<ObjectRow>();
}

export async function upsertObject(
  db: D1Database,
  input: {
    key: string;
    name?: string;
    size: number;
    contentType: string | null;
    etag: string | null;
    isPublic?: boolean;
  },
): Promise<ObjectRow> {
  const now = new Date().toISOString();
  const existing = await getObject(db, input.key, false);
  const name = input.name || existing?.name || fileNameFromKey(input.key);
  const isPublic = input.isPublic ?? (existing ? existing.is_public === 1 : true);
  const sortOrder = existing?.sort_order ?? 0;
  const description = existing?.description ?? '';

  await db
    .prepare(
      `INSERT INTO objects (key, name, size, content_type, etag, updated_at, is_public, sort_order, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name,
         size = excluded.size,
         content_type = excluded.content_type,
         etag = excluded.etag,
         updated_at = excluded.updated_at,
         is_public = excluded.is_public,
         sort_order = excluded.sort_order,
         description = excluded.description`,
    )
    .bind(input.key, name, input.size, input.contentType, input.etag, now, isPublic ? 1 : 0, sortOrder, description)
    .run();

  const row = await getObject(db, input.key, false);
  if (!row) throw new Error('Object index write failed');
  return row;
}

export async function patchObject(
  db: D1Database,
  key: string,
  patch: { name?: string; description?: string; isPublic?: boolean; sortOrder?: number },
): Promise<ObjectRow | null> {
  const existing = await getObject(db, key, false);
  if (!existing) return null;

  const name = patch.name?.trim() || existing.name;
  const description = patch.description ?? existing.description;
  const isPublic = patch.isPublic === undefined ? existing.is_public : patch.isPublic ? 1 : 0;
  const sortOrder = Number.isFinite(patch.sortOrder) ? Number(patch.sortOrder) : existing.sort_order;

  await db
    .prepare(
      `UPDATE objects
       SET name = ?, description = ?, is_public = ?, sort_order = ?, updated_at = ?
       WHERE key = ?`,
    )
    .bind(name, description, isPublic, sortOrder, new Date().toISOString(), key)
    .run();

  return await getObject(db, key, false);
}

export async function deleteObjectIndex(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM objects WHERE key = ?`).bind(key).run();
}

export function rowToFileEntry(row: ObjectRow): FileEntry {
  return toFileEntry(row);
}
