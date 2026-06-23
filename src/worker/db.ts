import type {
  DirectoryEntry,
  EntryRow,
  FileEntry,
  ObjectRow,
  StorageRecoveryOperationKind,
  StorageRecoveryOperationRow,
  TreeResponse,
} from './types';

export const LEGACY_OBJECT_MIGRATION_LOCK = 'legacy_object_migration_lock';
export const LEGACY_OBJECT_MUTATION_RESERVATION_PREFIX = 'legacy_object_mutation_reservation_';
export const LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS = 15 * 60_000;

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
  leaseDurationMs = LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS,
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
    .bind(reservation.key, leaseValue(owner, now + leaseDurationMs), LEGACY_OBJECT_MIGRATION_LOCK, now)
    .run();
  return result.meta.changes === 1 ? reservation : null;
}

export async function releaseLegacyObjectMutationReservation(
  db: D1Database,
  reservation: LegacyObjectMutationReservation,
): Promise<void> {
  await db
    .prepare("DELETE FROM settings WHERE key = ? AND json_valid(value) AND json_extract(value, '$.owner') = ?")
    .bind(reservation.key, reservation.owner)
    .run();
}

export async function renewLegacyObjectMutationReservation(
  db: D1Database,
  reservation: LegacyObjectMutationReservation,
  now = Date.now(),
  leaseDurationMs = LEGACY_OBJECT_MUTATION_LEASE_DURATION_MS,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE settings SET value = ?
       WHERE key = ?
         AND json_valid(value)
         AND json_extract(value, '$.owner') = ?
         AND ${liveLeaseCondition()} > ?`,
    )
    .bind(leaseValue(reservation.owner, now + leaseDurationMs), reservation.key, reservation.owner, now)
    .run();
  return result.meta.changes === 1;
}

export async function countLegacyObjectMutationReservations(db: D1Database, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM settings WHERE key GLOB ? AND ${liveLeaseCondition()} > ?`)
    .bind(`${LEGACY_OBJECT_MUTATION_RESERVATION_PREFIX}*`, now)
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

export async function findEntryByStorageKey(db: D1Database, storageKey: string): Promise<EntryRow | null> {
  return db.prepare('SELECT * FROM entries WHERE storage_key = ?').bind(storageKey).first<EntryRow>();
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
  type AncestryRow = EntryRow & { ancestry_depth: number; ancestry_cycle: number };
  const result = await db
    .prepare(`
      WITH RECURSIVE ancestors(id, depth, path, cycle) AS (
        SELECT id, 0, ',' || hex(id) || ',', 0 FROM entries WHERE id = ?
        UNION ALL
        SELECT
          parent.id,
          child.depth + 1,
          child.path || hex(parent.id) || ',',
          instr(child.path, ',' || hex(parent.id) || ',') > 0
        FROM entries parent
        JOIN entries current ON current.parent_id = parent.id
        JOIN ancestors child ON current.id = child.id
        WHERE child.depth < 256 AND child.cycle = 0
      )
      SELECT entry.*, ancestors.depth AS ancestry_depth, ancestors.cycle AS ancestry_cycle
      FROM ancestors
      JOIN entries entry ON entry.id = ancestors.id
      ORDER BY ancestors.depth ASC
    `)
    .bind(id)
    .all<AncestryRow>();
  const rows = result.results ?? [];
  if (rows.some((row) => row.ancestry_cycle === 1)) return [];
  const last = rows.at(-1);
  if (last?.ancestry_depth === 256 && last.parent_id !== null) return [];
  return rows;
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

export async function insertEntry(db: D1Database, row: EntryRow): Promise<void> {
  await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag,
    status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      row.id, row.parent_id, row.name, row.kind, row.storage_key, row.size,
      row.content_type, row.etag, row.status, row.lifecycle_owner, row.is_public, row.sort_order,
      row.description, row.created_at, row.updated_at,
    )
    .run();
}

export async function insertEntryUnderReadyParent(db: D1Database, row: EntryRow): Promise<boolean> {
  if (!row.parent_id) throw new Error('Entry parent is required');
  const result = await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag,
    status, lifecycle_owner, is_public, sort_order, description, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM entries
    WHERE id = ? AND kind = 'folder' AND status = 'ready'
  )`)
    .bind(
      row.id, row.parent_id, row.name, row.kind, row.storage_key, row.size,
      row.content_type, row.etag, row.status, row.lifecycle_owner, row.is_public, row.sort_order,
      row.description, row.created_at, row.updated_at, row.parent_id,
    )
    .run();
  return result.meta.changes === 1;
}

export async function finalizeUploadedEntry(
  db: D1Database,
  id: string,
  owner: string,
  metadata: { size: number; contentType: string | null; etag: string | null },
): Promise<boolean> {
  const result = await db.prepare(`UPDATE entries
    SET size = ?, content_type = ?, etag = ?, status = 'ready', lifecycle_owner = NULL, updated_at = ?
    WHERE id = ? AND status = 'uploading' AND lifecycle_owner = ?`)
    .bind(metadata.size, metadata.contentType, metadata.etag, new Date().toISOString(), id, owner)
    .run();
  return result.meta.changes === 1;
}

export async function updateReadyEntryFields(
  db: D1Database,
  id: string,
  fields: { name?: string; description?: string; sortOrder?: number; isPublic?: boolean },
): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (fields.name !== undefined) add('name', fields.name);
  if (fields.description !== undefined) add('description', fields.description);
  if (fields.sortOrder !== undefined) add('sort_order', fields.sortOrder);
  if (fields.isPublic !== undefined) add('is_public', fields.isPublic ? 1 : 0);
  add('updated_at', new Date().toISOString());
  const result = await db.prepare(`UPDATE entries SET ${assignments.join(', ')} WHERE id = ? AND status = 'ready'`)
    .bind(...values, id)
    .run();
  return result.meta.changes === 1;
}

export async function moveReadyEntry(db: D1Database, id: string, destinationId: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE entries
    SET parent_id = ?, updated_at = ?
    WHERE id = ? AND status = 'ready'
      AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND kind = 'folder' AND status = 'ready')`)
    .bind(destinationId, new Date().toISOString(), id, destinationId)
    .run();
  return result.meta.changes === 1;
}

export async function deleteUploadingEntry(db: D1Database, id: string, owner: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM entries WHERE id = ? AND status = 'uploading' AND lifecycle_owner = ?")
    .bind(id, owner)
    .run();
  return result.meta.changes === 1;
}

export async function claimEntryTreeForDeletion(db: D1Database, id: string, owner: string): Promise<boolean> {
  const result = await db.prepare(`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM entries WHERE id = ?
    UNION ALL
    SELECT child.id FROM entries child JOIN descendants parent ON child.parent_id = parent.id
  )
  UPDATE entries
  SET status = 'deleting', lifecycle_owner = ?, updated_at = ?
  WHERE id IN (SELECT id FROM descendants)
    AND NOT EXISTS (
      SELECT 1 FROM entries
      WHERE id IN (SELECT id FROM descendants) AND status <> 'ready'
    )`)
    .bind(id, owner, new Date().toISOString())
    .run();
  return result.meta.changes > 0;
}

export async function countDescendantRows(db: D1Database, id: string): Promise<number> {
  const row = await db.prepare(`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM entries WHERE id = ?
    UNION ALL
    SELECT child.id FROM entries child JOIN descendants parent ON child.parent_id = parent.id
  )
  SELECT COUNT(*) AS count FROM descendants`)
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function deleteDeletingEntry(db: D1Database, id: string, owner: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM entries WHERE id = ? AND status = 'deleting' AND lifecycle_owner = ?")
    .bind(id, owner)
    .run();
  return result.meta.changes === 1;
}

export async function enqueueStorageRecoveryOperation(
  db: D1Database,
  input: {
    id: string;
    entryId: string;
    operationKind: StorageRecoveryOperationKind;
    storageKey: string | null;
    attemptOwner: string;
    phase: string;
    payload?: unknown;
    state: 'held' | 'pending' | 'retry';
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.prepare(`INSERT OR IGNORE INTO storage_recovery_operations (
    id, entry_id, operation_kind, storage_key, attempt_owner, phase, payload, state,
    claim_owner, claim_expires_at, attempts, last_error, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)`)
    .bind(
      input.id, input.entryId, input.operationKind, input.storageKey, input.attemptOwner,
      input.phase, JSON.stringify(input.payload ?? {}), input.state, now, now,
    )
    .run();
  return result.meta.changes === 1;
}

export async function touchHeldStorageRecoveryOperation(
  db: D1Database,
  operationId: string,
  attemptOwner: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET updated_at = ?
    WHERE id = ? AND state = 'held' AND attempt_owner = ?`)
    .bind(new Date(now).toISOString(), operationId, attemptOwner)
    .run();
  return result.meta.changes === 1;
}

export async function listStorageRecoveryOperations(
  db: D1Database,
  entryId?: string,
  limit = 100,
  now = Date.now(),
): Promise<StorageRecoveryOperationRow[]> {
  const result = entryId
    ? await db.prepare(`SELECT * FROM storage_recovery_operations WHERE entry_id = ? ORDER BY created_at ASC LIMIT ?`)
      .bind(entryId, limit).all<StorageRecoveryOperationRow>()
    : await db.prepare(`SELECT * FROM storage_recovery_operations
      WHERE state IN ('pending', 'retry')
        OR (state = 'running' AND COALESCE(claim_expires_at, 0) <= ?)
        OR (state = 'held' AND updated_at <= ?)
      ORDER BY updated_at ASC LIMIT ?`)
      .bind(now, new Date(now - 5 * 60_000).toISOString(), limit).all<StorageRecoveryOperationRow>();
  return result.results ?? [];
}

export async function activateStorageRecoveryOperation(
  db: D1Database,
  id: string,
  phase: string,
  payload: unknown = {},
): Promise<boolean> {
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET phase = ?, payload = ?, state = 'pending', updated_at = ?
    WHERE id = ? AND state = 'held'`)
    .bind(phase, JSON.stringify(payload), new Date().toISOString(), id)
    .run();
  return result.meta.changes === 1;
}

export async function claimStorageRecoveryOperation(
  db: D1Database,
  id: string,
  claimOwner: string,
  leaseDurationMs = 30_000,
  now = Date.now(),
): Promise<StorageRecoveryOperationRow | null> {
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET state = 'running', claim_owner = ?, claim_expires_at = ?, attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND (
      state IN ('pending', 'retry')
        OR (state = 'running' AND COALESCE(claim_expires_at, 0) <= ?)
        OR (state = 'held' AND updated_at <= ?)
    )`)
    .bind(claimOwner, now + leaseDurationMs, new Date().toISOString(), id, now, new Date(now - 5 * 60_000).toISOString())
    .run();
  if (result.meta.changes !== 1) return null;
  return db.prepare(`SELECT * FROM storage_recovery_operations WHERE id = ? AND state = 'running' AND claim_owner = ?`)
    .bind(id, claimOwner)
    .first<StorageRecoveryOperationRow>();
}

export async function renewStorageRecoveryOperation(
  db: D1Database,
  id: string,
  claimOwner: string,
  leaseDurationMs = 30_000,
  now = Date.now(),
): Promise<boolean> {
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET claim_expires_at = ?, updated_at = ?
    WHERE id = ? AND state = 'running' AND claim_owner = ? AND COALESCE(claim_expires_at, 0) > ?`)
    .bind(now + leaseDurationMs, new Date(now).toISOString(), id, claimOwner, now)
    .run();
  return result.meta.changes === 1;
}

export async function updateClaimedStorageRecoveryOperation(
  db: D1Database,
  id: string,
  claimOwner: string,
  phase: string,
  payload: unknown,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET phase = ?, payload = ?, updated_at = ?
    WHERE id = ? AND state = 'running' AND claim_owner = ?`)
    .bind(phase, JSON.stringify(payload), new Date().toISOString(), id, claimOwner)
    .run();
  return result.meta.changes === 1;
}

export async function completeStorageRecoveryOperation(db: D1Database, id: string, claimOwner: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET state = 'completed', claim_owner = NULL, claim_expires_at = NULL, last_error = NULL, updated_at = ?
    WHERE id = ? AND state = 'running' AND claim_owner = ?`)
    .bind(new Date().toISOString(), id, claimOwner)
    .run();
  return result.meta.changes === 1;
}

export async function retryStorageRecoveryOperation(
  db: D1Database,
  id: string,
  claimOwner: string,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const result = await db.prepare(`UPDATE storage_recovery_operations
    SET state = 'retry', claim_owner = NULL, claim_expires_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND state = 'running' AND claim_owner = ?`)
    .bind(message.slice(0, 1000), new Date().toISOString(), id, claimOwner)
    .run();
  return result.meta.changes === 1;
}

export interface AuthRateLimitRow {
  key_hash: string;
  scope: string;
  window_started_at: number;
  failure_count: number;
  blocked_until: number;
  reservation_token: string | null;
  reservation_expires_at: number;
  updated_at: number;
}

export function getAuthRateLimit(db: D1Database, keyHash: string): Promise<AuthRateLimitRow | null> {
  return db.prepare('SELECT * FROM auth_rate_limits WHERE key_hash = ?').bind(keyHash).first<AuthRateLimitRow>();
}

export function reserveAuthRateLimitVerification(
  db: D1Database,
  keyHash: string,
  scope: string,
  reservationToken: string,
  now: number,
  windowSeconds: number,
  maxFailures: number,
  reservationSeconds: number,
): Promise<AuthRateLimitRow | null> {
  return db.prepare(`INSERT INTO auth_rate_limits (
      key_hash, scope, window_started_at, failure_count, blocked_until,
      reservation_token, reservation_expires_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, ?, ? + ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      scope = excluded.scope,
      window_started_at = CASE
        WHEN excluded.updated_at >= auth_rate_limits.window_started_at + ? THEN excluded.window_started_at
        ELSE auth_rate_limits.window_started_at
      END,
      failure_count = CASE
        WHEN excluded.updated_at >= auth_rate_limits.window_started_at + ? THEN 0
        ELSE auth_rate_limits.failure_count
      END,
      blocked_until = CASE
        WHEN excluded.updated_at >= auth_rate_limits.window_started_at + ? THEN 0
        ELSE auth_rate_limits.blocked_until
      END,
      reservation_token = excluded.reservation_token,
      reservation_expires_at = excluded.reservation_expires_at,
      updated_at = excluded.updated_at
    WHERE auth_rate_limits.reservation_expires_at <= excluded.updated_at
      AND (
        excluded.updated_at >= auth_rate_limits.window_started_at + ?
        OR (
          auth_rate_limits.failure_count < ?
          AND auth_rate_limits.blocked_until <= excluded.updated_at
        )
      )
    RETURNING *`)
    .bind(
      keyHash, scope, now, reservationToken, now, reservationSeconds, now,
      windowSeconds, windowSeconds, windowSeconds, windowSeconds, maxFailures,
    )
    .first<AuthRateLimitRow>();
}

export async function recordAuthRateLimitFailure(
  db: D1Database,
  keyHash: string,
  scope: string,
  reservationToken: string,
  now: number,
  windowSeconds: number,
  maxBackoffSeconds: number,
): Promise<number> {
  const row = await db.prepare(`UPDATE auth_rate_limits SET
      scope = ?,
      window_started_at = CASE
        WHEN ? >= window_started_at + ? THEN ?
        ELSE auth_rate_limits.window_started_at
      END,
      failure_count = CASE
        WHEN ? >= window_started_at + ? THEN 1
        ELSE auth_rate_limits.failure_count + 1
      END,
      blocked_until = CASE
        WHEN ? >= window_started_at + ? THEN ? + 1
        ELSE ? + MIN(?, 1 << auth_rate_limits.failure_count)
      END,
      reservation_token = NULL,
      reservation_expires_at = 0,
      updated_at = ?
    WHERE key_hash = ? AND reservation_token = ?
    RETURNING failure_count`)
    .bind(
      scope,
      now, windowSeconds, now,
      now, windowSeconds,
      now, windowSeconds, now,
      now, maxBackoffSeconds,
      now,
      keyHash, reservationToken,
    )
    .first<{ failure_count: number }>();
  return row?.failure_count ?? 0;
}

export async function clearAuthRateLimit(db: D1Database, keyHash: string, reservationToken: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM auth_rate_limits WHERE key_hash = ? AND reservation_token = ?')
    .bind(keyHash, reservationToken)
    .run();
  return result.meta.changes === 1;
}

export async function deleteAuthRateLimitsBefore(
  db: D1Database,
  cutoff: number,
  limit = 100,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db.prepare(`DELETE FROM auth_rate_limits
    WHERE key_hash IN (
      SELECT key_hash FROM auth_rate_limits
      WHERE updated_at < ?
      ORDER BY updated_at ASC
      LIMIT ?
    )`)
    .bind(cutoff, boundedLimit)
    .run();
  return result.meta.changes;
}
