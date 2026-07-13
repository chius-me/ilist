import { HttpError } from './http';
import type { Mount, MountDriverType, MountRow } from './types';

const RESERVED_MOUNT_NAMES = new Set(['api', 'file', 'admin']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface CreateMountInput {
  name: string;
  mountPath: string;
  driverType: MountDriverType;
  provider: string;
  enabled?: boolean;
  isPublic?: boolean;
  sortOrder?: number;
  rootItemId?: string | null;
  config?: unknown;
}

export interface UpdateMountInput {
  name?: string;
  mountPath?: string;
  driverType?: MountDriverType;
  provider?: string;
  enabled?: boolean;
  isPublic?: boolean;
  sortOrder?: number;
  rootItemId?: string | null;
  config?: unknown;
}

export interface PreparedMountUpdate {
  statement: D1PreparedStatement;
  id: string;
  name: string;
  mountPath: string;
}

export function normalizeMountPath(input: string): string {
  let path: string;
  try {
    path = decodeURIComponent(input);
  } catch {
    throw new HttpError(400, 'INVALID_MOUNT_PATH', 'Mount path has invalid encoding');
  }

  if (!path.startsWith('/')) {
    throw new HttpError(400, 'INVALID_MOUNT_PATH', 'Mount path must have a leading slash');
  }

  const segment = path.slice(1);
  if (!segment || segment.includes('/')) {
    throw new HttpError(400, 'INVALID_MOUNT_PATH', 'Mount path must contain a single segment');
  }
  if (segment === '.' || segment === '..') {
    throw new HttpError(400, 'INVALID_MOUNT_PATH', 'Mount path cannot be a dot segment');
  }
  if (CONTROL_CHARACTERS.test(segment)) {
    throw new HttpError(400, 'INVALID_MOUNT_PATH', 'Mount path cannot contain control characters');
  }
  if (RESERVED_MOUNT_NAMES.has(segment.toLowerCase())) {
    throw new HttpError(400, 'RESERVED_MOUNT_PATH', 'Mount path uses a reserved name');
  }
  return `/${segment}`;
}

function normalizeMountName(input: string): string {
  const name = input.trim();
  if (!name || CONTROL_CHARACTERS.test(name)) {
    throw new HttpError(400, 'INVALID_MOUNT_NAME', 'Mount name is invalid');
  }
  return name;
}

function normalizeProvider(input: string): string {
  const provider = input.trim();
  if (!provider || CONTROL_CHARACTERS.test(provider)) {
    throw new HttpError(400, 'INVALID_MOUNT_PROVIDER', 'Mount provider is invalid');
  }
  return provider;
}

function normalizeSortOrder(input: number): number {
  if (!Number.isFinite(input)) {
    throw new HttpError(400, 'INVALID_MOUNT_SORT_ORDER', 'Mount sort order is invalid');
  }
  return input;
}

function serializeConfig(config: unknown): string {
  try {
    const json = JSON.stringify(config ?? {});
    if (json === undefined) throw new Error('undefined JSON');
    return json;
  } catch {
    throw new HttpError(400, 'INVALID_MOUNT_CONFIG', 'Mount configuration must be JSON serializable');
  }
}

function toMount(row: MountRow): Mount {
  return {
    id: row.id,
    name: row.name,
    mountPath: row.mount_path,
    driverType: row.driver_type,
    provider: row.provider,
    enabled: row.enabled === 1,
    isPublic: row.is_public === 1,
    sortOrder: row.sort_order,
    rootItemId: row.root_item_id,
    config: JSON.parse(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findMountRow(db: D1Database, id: string): Promise<MountRow | null> {
  return db.prepare('SELECT * FROM mounts WHERE id = ?').bind(id).first<MountRow>();
}

async function assertNoConflict(db: D1Database, name: string, mountPath: string, excludeId?: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT id, mount_path FROM mounts
       WHERE (mount_path = ? OR LOWER(name) = LOWER(?))
         AND (? IS NULL OR id <> ?)`,
    )
    .bind(mountPath, name, excludeId ?? null, excludeId ?? null)
    .first<{ id: string; mount_path: string }>();
  if (!row) return;
  if (row.mount_path === mountPath) {
    throw new HttpError(409, 'MOUNT_PATH_CONFLICT', 'Mount path is already in use', { mountPath });
  }
  throw new HttpError(409, 'MOUNT_NAME_CONFLICT', 'Mount name is already in use', { name });
}

function uniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

export async function listMounts(db: D1Database): Promise<Mount[]> {
  const result = await db.prepare('SELECT * FROM mounts ORDER BY sort_order ASC, name COLLATE NOCASE ASC').all<MountRow>();
  return (result.results ?? []).map(toMount);
}

export async function getMount(db: D1Database, id: string): Promise<Mount | null> {
  const row = await findMountRow(db, id);
  return row ? toMount(row) : null;
}

export async function createMount(db: D1Database, input: CreateMountInput): Promise<Mount> {
  const name = normalizeMountName(input.name);
  const mountPath = normalizeMountPath(input.mountPath);
  const provider = normalizeProvider(input.provider);
  const sortOrder = normalizeSortOrder(input.sortOrder ?? 0);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await assertNoConflict(db, name, mountPath);
  try {
    await db
      .prepare(
        `INSERT INTO mounts (
          id, name, mount_path, driver_type, provider, enabled, is_public,
          sort_order, root_item_id, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        name,
        mountPath,
        input.driverType,
        provider,
        input.enabled === false ? 0 : 1,
        input.isPublic === false ? 0 : 1,
        sortOrder,
        input.rootItemId ?? null,
        serializeConfig(input.config),
        now,
        now,
      )
      .run();
  } catch (error) {
    if (uniqueConstraint(error)) {
      await assertNoConflict(db, name, mountPath);
      throw new HttpError(409, 'MOUNT_PATH_CONFLICT', 'Mount path is already in use', { mountPath });
    }
    throw error;
  }

  const mount = await getMount(db, id);
  if (!mount) throw new Error('Mount write failed');
  return mount;
}

export async function prepareMountUpdate(
  db: D1Database,
  id: string,
  input: UpdateMountInput,
): Promise<PreparedMountUpdate | null> {
  const current = await findMountRow(db, id);
  if (!current) return null;

  const name = input.name === undefined ? current.name : normalizeMountName(input.name);
  const mountPath = input.mountPath === undefined ? current.mount_path : normalizeMountPath(input.mountPath);
  const provider = input.provider === undefined ? current.provider : normalizeProvider(input.provider);
  const sortOrder = input.sortOrder === undefined ? current.sort_order : normalizeSortOrder(input.sortOrder);
  const configJson = input.config === undefined ? current.config_json : serializeConfig(input.config);

  await assertNoConflict(db, name, mountPath, id);
  const statement = db
    .prepare(
      `UPDATE mounts
       SET name = ?, mount_path = ?, driver_type = ?, provider = ?, enabled = ?, is_public = ?,
           sort_order = ?, root_item_id = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      name,
      mountPath,
      input.driverType ?? current.driver_type,
      provider,
      input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      input.isPublic === undefined ? current.is_public : input.isPublic ? 1 : 0,
      sortOrder,
      input.rootItemId === undefined ? current.root_item_id : input.rootItemId,
      configJson,
      new Date().toISOString(),
      id,
    );
  return { statement, id, name, mountPath };
}

export async function rethrowMountWriteError(
  db: D1Database,
  error: unknown,
  update: PreparedMountUpdate,
): Promise<never> {
  if (uniqueConstraint(error)) {
    await assertNoConflict(db, update.name, update.mountPath, update.id);
    throw new HttpError(409, 'MOUNT_PATH_CONFLICT', 'Mount path is already in use', { mountPath: update.mountPath });
  }
  throw error;
}

export async function updateMount(db: D1Database, id: string, input: UpdateMountInput): Promise<Mount | null> {
  const update = await prepareMountUpdate(db, id, input);
  if (!update) return null;
  try {
    await update.statement.run();
  } catch (error) {
    await rethrowMountWriteError(db, error, update);
  }

  return getMount(db, id);
}

export function prepareMountDelete(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM mounts WHERE id = ?').bind(id);
}

export async function deleteMount(db: D1Database, id: string): Promise<void> {
  await prepareMountDelete(db, id).run();
}
