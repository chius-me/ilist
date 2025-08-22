import type { DirectoryEntry, EntryRow, FileEntry, ObjectRow, TreeResponse } from './types';

export const LEGACY_OBJECT_MIGRATION_LOCK = 'legacy_object_migration_lock';
export const LEGACY_OBJECT_MUTATION_RESERVATION_PREFIX = 'legacy_object_mutation_reservation_';

export interface LegacyObjectMutationReservation {
  key: string;
  owner: string;
}

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

function leaseValue(owner: string, expiresAt: number): string {
  return JSON.stringify({ owner, expires_at: expiresAt });
}

function liveLeaseCondition(column = 'value'): string {
  return `CASE
    WHEN json_valid(${column}) THEN COALESCE(CAST(json_extract(${column}, '$.expires_at') AS INTEGER), 0)
    ELSE 0
  END`;
}

export async function isLegacyObjectMigrationLocked(db: D1Database, now = Date.now()): Promise<boolean> {
  return Boolean(
    await db
      .prepare(`SELECT 1 FROM settings WHERE key = ? AND ${liveLeaseCondition()} > ?`)
      .bind(LEGACY_OBJECT_MIGRATION_LOCK, now)
      .first(),
  );
}

export async function reserveLegacyObjectMutation(
  db: D1Database,
  owner: string = crypto.randomUUID(),
  now = Date.now(),
): Promise<LegacyObjectMutationReservation | null> {
  const reservation = { key: `${LEGACY_OBJECT_MUTATION_RESERVATION_PREFIX}${owner}`, owner };
  const result = await db
    .prepare(
      `INSERT INTO settings (key, value)
       SELECT ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM settings
         WHERE key = ? AND ${liveLeaseCondition()} > ?
       )`,
    )
    .bind(reservation.key, owner, LEGACY_OBJECT_MIGRATION_LOCK, now)
    .run();
  return result.meta.changes === 1 ? reservation : null;
}

export async function releaseLegacyObjectMutationReservation(
  db: D1Database,
  reservation: LegacyObjectMutationReservation,
): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ? AND value = ?').bind(reservation.key, reservation.owner).run();
}

export async function countLegacyObjectMutationReservations(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM settings WHERE key GLOB ?')
    .bind(`${LEGACY_OBJECT_MUTATION_RESERVATION_PREFIX}*`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function acquireLegacyObjectMigrationLease(
  db: D1Database,
  owner: string,
  now = Date.now(),
  leaseDurationMs = 300_000,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE ${liveLeaseCondition('settings.value')} <= ?`,
    )
    .bind(LEGACY_OBJECT_MIGRATION_LOCK, leaseValue(owner, now + leaseDurationMs), now)
    .run();
  return result.meta.changes === 1;
}

export async function renewLegacyObjectMigrationLease(
  db: D1Database,
  owner: string,
  now = Date.now(),
  leaseDurationMs = 300_000,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE settings SET value = ?
       WHERE key = ?
         AND json_valid(value)
         AND json_extract(value, '$.owner') = ?
         AND ${liveLeaseCondition()} > ?`,
    )
    .bind(leaseValue(owner, now + leaseDurationMs), LEGACY_OBJECT_MIGRATION_LOCK, owner, now)
    .run();
  return result.meta.changes === 1;
}

export async function releaseLegacyObjectMigrationLease(db: D1Database, owner: string): Promise<void> {
  await db
    .prepare("DELETE FROM settings WHERE key = ? AND json_valid(value) AND json_extract(value, '$.owner') = ?")
    .bind(LEGACY_OBJECT_MIGRATION_LOCK, owner)
    .run();
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

export async function getEntryById(db: D1Database, id: string): Promise<EntryRow | null> {
  return db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
}

export async function getChildByName(db: D1Database, parentId: string, name: string): Promise<EntryRow | null> {
  return db.prepare('SELECT * FROM entries WHERE parent_id = ? AND name = ?').bind(parentId, name).first<EntryRow>();
}

export async function listChildRows(db: D1Database, parentId: string): Promise<EntryRow[]> {
  const result = await db
    .prepare(`SELECT * FROM entries WHERE parent_id = ? AND status = 'ready' ORDER BY kind DESC, sort_order ASC, name ASC`)
    .bind(parentId)
    .all<EntryRow>();
  return result.results ?? [];
}

export async function listAncestorRows(db: D1Database, id: string): Promise<EntryRow[]> {
  const result = await db
    .prepare(`
      WITH RECURSIVE ancestors(id, depth) AS (
        SELECT id, 0 FROM entries WHERE id = ?
        UNION ALL
        SELECT parent.id, child.depth + 1
        FROM entries parent
        JOIN entries current ON current.parent_id = parent.id
        JOIN ancestors child ON current.id = child.id
      )
      SELECT entry.* FROM ancestors JOIN entries entry ON entry.id = ancestors.id ORDER BY ancestors.depth ASC
    `)
    .bind(id)
    .all<EntryRow>();
  return result.results ?? [];
}

export async function listDescendantRows(db: D1Database, id: string): Promise<EntryRow[]> {
  const result = await db
    .prepare(`
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 0 FROM entries WHERE id = ?
        UNION ALL
        SELECT child.id, parent.depth + 1
        FROM entries child
        JOIN descendants parent ON child.parent_id = parent.id
      )
      SELECT entry.* FROM descendants JOIN entries entry ON entry.id = descendants.id ORDER BY descendants.depth ASC
    `)
    .bind(id)
    .all<EntryRow>();
  return result.results ?? [];
}
