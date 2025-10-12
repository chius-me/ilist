import {
  activateStorageRecoveryOperation,
  claimStorageRecoveryOperation,
  claimEntryTreeForDeletion,
  completeStorageRecoveryOperation,
  countDescendantRows,
  deleteDeletingEntry,
  deleteUploadingEntry,
  enqueueStorageRecoveryOperation,
  finalizeUploadedEntry,
  findEntryByStorageKey,
  getChildByName,
  getEntryById,
  insertEntryUnderReadyParent,
  listAncestorRows,
  listDescendantRows,
  listStorageRecoveryOperations,
  moveReadyEntry,
  renewStorageRecoveryOperation,
  retryStorageRecoveryOperation,
  touchHeldStorageRecoveryOperation,
  updateClaimedStorageRecoveryOperation,
  updateReadyEntryFields,
} from './db';
import { storageKeyForEntry, validateEntryName } from './entry-domain';
import { entryToApi, isEffectivelyPublic, listDirectory } from './entries';
import { HttpError } from './http';
import { resolveVirtualPath } from './mount-resolver';
import { listMounts } from './mounts';
import type {
  BatchResult,
  Breadcrumb,
  Entry,
  EntryCapabilities,
  EntryRow,
  Env,
  Mount,
  MountEntry,
  StorageRecoveryOperationRow,
  VirtualDirectoryResponse,
} from './types';

const ENTRY_NAME_UNIQUE_CONSTRAINT = 'UNIQUE constraint failed: entries.parent_id, entries.name';
const ENTRY_ID_UNIQUE_CONSTRAINT = 'UNIQUE constraint failed: entries.id';
const UPLOAD_HEARTBEAT_INTERVAL_MS = 60_000;
const VIRTUAL_ROOT_ID = 'virtual-root';

const READ_ONLY_FOLDER_CAPABILITIES: EntryCapabilities = {
  open: true,
  preview: false,
  download: false,
  rename: false,
  move: false,
  delete: false,
  changeVisibility: false,
};

function virtualRootEntry(): Entry {
  return {
    id: VIRTUAL_ROOT_ID,
    parentId: null,
    name: 'ilist',
    kind: 'folder',
    size: 0,
    contentType: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
    isPublic: true,
    effectivePublic: true,
    sortOrder: 0,
    description: '',
    capabilities: READ_ONLY_FOLDER_CAPABILITIES,
  };
}

function mountEntry(mount: Mount): MountEntry {
  return {
    id: mount.id,
    parentId: VIRTUAL_ROOT_ID,
    name: mount.name,
    kind: 'folder',
    size: 0,
    contentType: null,
    updatedAt: mount.updatedAt,
    isPublic: mount.isPublic,
    effectivePublic: mount.isPublic,
    sortOrder: mount.sortOrder,
    description: '',
    capabilities: READ_ONLY_FOLDER_CAPABILITIES,
    mountId: mount.id,
    mountPath: mount.mountPath,
    driverType: mount.driverType,
    provider: mount.provider,
  };
}

function withMountIdentity(entry: Entry, mount: Mount): MountEntry {
  return {
    ...entry,
    mountId: mount.id,
    mountPath: mount.mountPath,
    driverType: mount.driverType,
    provider: mount.provider,
  };
}

function encodedMountPath(mount: Mount): string {
  return `/${encodeURIComponent(mount.mountPath.slice(1))}`;
}

function mountedBreadcrumbs(mount: Mount, breadcrumbs: Breadcrumb[]): Breadcrumb[] {
  const mountPath = encodedMountPath(mount);
  return [
    { id: VIRTUAL_ROOT_ID, name: 'ilist', path: '/' },
    { id: mount.id, name: mount.name, path: mountPath },
    ...breadcrumbs.slice(1).map((breadcrumb) => ({
      ...breadcrumb,
      path: `${mountPath}${breadcrumb.path}`,
    })),
  ];
}

export async function listVirtualDirectory(
  db: D1Database,
  pathname: string,
  admin: boolean,
): Promise<VirtualDirectoryResponse> {
  const mounts = await listMounts(db);
  if (pathname === '/') {
    return {
      current: virtualRootEntry(),
      breadcrumbs: [{ id: VIRTUAL_ROOT_ID, name: 'ilist', path: '/' }],
      items: mounts
        .filter((mount) => mount.enabled && (admin || mount.isPublic))
        .map(mountEntry),
    };
  }

  const resolvableMounts = admin ? mounts : mounts.filter((mount) => mount.isPublic);
  const { mount, relativePath } = resolveVirtualPath(pathname, resolvableMounts);
  if (mount.driverType !== 'native-r2') {
    throw new HttpError(503, 'DRIVER_UNAVAILABLE', 'Storage driver is unavailable');
  }

  const directory = await listDirectory(db, relativePath, admin);
  return {
    current: withMountIdentity(directory.current, mount),
    breadcrumbs: mountedBreadcrumbs(mount, directory.breadcrumbs),
    items: directory.items.map((entry) => withMountIdentity(entry, mount)),
  };
}

interface UploadRecoveryHeartbeatOptions {
  now?: () => number;
  heartbeatIntervalMs?: number;
  setInterval?: (callback: () => Promise<void>, delay: number) => unknown;
  clearInterval?: (interval: unknown) => void;
}

interface UploadFileOptions {
  recoveryHeartbeat?: UploadRecoveryHeartbeatOptions;
}

interface RecoveryClaimHeartbeatOptions {
  now?: () => number;
  heartbeatIntervalMs?: number;
  setInterval?: (callback: () => Promise<void>, delay: number) => unknown;
  clearInterval?: (interval: unknown) => void;
}

interface RecoveryClaimHeartbeat {
  stop: () => void;
  touch: () => Promise<void>;
  ownershipLost: () => boolean;
}

function startUploadRecoveryHeartbeat(
  db: D1Database,
  operationId: string,
  attemptOwner: string,
  options: UploadRecoveryHeartbeatOptions = {},
): { stop: () => void; touch: () => Promise<void>; ownershipLost: () => boolean } {
  let active = true;
  let stopped = false;
  let lostOwnership = false;
  const now = options.now ?? Date.now;
  const setHeartbeatInterval = options.setInterval
    ?? ((callback: () => Promise<void>, delay: number) => globalThis.setInterval(() => { void callback(); }, delay));
  const clearHeartbeatInterval = options.clearInterval
    ?? ((interval: unknown) => globalThis.clearInterval(interval as number));
  let interval: unknown;
  let intervalStarted = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active = false;
    if (intervalStarted) clearHeartbeatInterval(interval);
  };
  const touch = async () => {
    if (!active) return;
    try {
      if (!await touchHeldStorageRecoveryOperation(db, operationId, attemptOwner, now())) {
        lostOwnership = true;
        stop();
      }
    } catch {
      // A failed heartbeat leaves the held operation recoverable once it becomes stale.
    }
  };
  interval = setHeartbeatInterval(touch, options.heartbeatIntervalMs ?? UPLOAD_HEARTBEAT_INTERVAL_MS);
  intervalStarted = true;
  if (stopped) clearHeartbeatInterval(interval);

  return {
    stop,
    touch,
    ownershipLost: () => lostOwnership,
  };
}

function startRecoveryClaimHeartbeat(
  db: D1Database,
  operationId: string,
  claimOwner: string,
  leaseDurationMs: number,
  options: RecoveryClaimHeartbeatOptions = {},
): RecoveryClaimHeartbeat {
  let active = true;
  let stopped = false;
  let lostOwnership = false;
  const now = options.now ?? Date.now;
  const setHeartbeatInterval = options.setInterval
    ?? ((callback: () => Promise<void>, delay: number) => globalThis.setInterval(() => { void callback(); }, delay));
  const clearHeartbeatInterval = options.clearInterval
    ?? ((interval: unknown) => globalThis.clearInterval(interval as number));
  let interval: unknown;
  let intervalStarted = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active = false;
    if (intervalStarted) clearHeartbeatInterval(interval);
  };
  const touch = async () => {
    if (!active) return;
    try {
      if (!await renewStorageRecoveryOperation(db, operationId, claimOwner, leaseDurationMs, now())) {
        lostOwnership = true;
        stop();
      }
    } catch {
      // A failed heartbeat leaves the operation recoverable once its lease expires.
    }
  };
  interval = setHeartbeatInterval(touch, options.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseDurationMs / 3)));
  intervalStarted = true;
  if (stopped) clearHeartbeatInterval(interval);

  return { stop, touch, ownershipLost: () => lostOwnership };
}

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
  if (!row) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  if (row.status !== 'ready') throw new HttpError(409, 'ENTRY_MUTATION_CONFLICT', 'Entry changed or deletion was claimed');
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
    lifecycle_owner: null,
    is_public: parent.is_public, sort_order: 0, description: '', created_at: now, updated_at: now,
  };
  try {
    if (!await insertEntryUnderReadyParent(db, row)) {
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Folder not found');
    }
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
    if (!await updateReadyEntryFields(db, id, { ...patch, ...(name === undefined ? {} : { name }) })) {
      throw new HttpError(409, 'ENTRY_MUTATION_CONFLICT', 'Entry changed or deletion was claimed');
    }
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
      if (!await moveReadyEntry(db, row.id, destination.id)) {
        throw new HttpError(409, 'ENTRY_MUTATION_CONFLICT', 'Entry changed or deletion was claimed');
      }
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
      if (!await updateReadyEntryFields(db, id, { isPublic })) {
        throw new HttpError(409, 'ENTRY_MUTATION_CONFLICT', 'Entry changed or deletion was claimed');
      }
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
  options: UploadFileOptions = {},
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
  const owner = crypto.randomUUID();
  const operationId = `upload:${id}:${owner}`;
  const row: EntryRow = {
    id,
    parent_id: parent.id,
    name,
    kind: 'file',
    storage_key: storageKeyForEntry(id, owner),
    size: 0,
    content_type: request.headers.get('content-type'),
    etag: null,
    status: 'uploading',
    lifecycle_owner: owner,
    is_public: parent.is_public,
    sort_order: 0,
    description: '',
    created_at: now,
    updated_at: now,
  };

  try {
    if (!await enqueueStorageRecoveryOperation(env.DB, {
      id: operationId,
      entryId: id,
      operationKind: 'upload_cleanup',
      storageKey: row.storage_key,
      attemptOwner: owner,
      phase: 'uploading',
      state: 'held',
    })) {
      throw new HttpError(409, 'UPLOAD_IN_PROGRESS', 'An upload for this entry ID is already in progress');
    }
    if (!await insertEntryUnderReadyParent(env.DB, row)) {
      await activateStorageRecoveryOperation(env.DB, operationId, 'cleanup_blob').catch(() => undefined);
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Folder not found');
    }
  } catch (error) {
    await activateStorageRecoveryOperation(env.DB, operationId, 'cleanup_blob').catch(() => undefined);
    if (entryIdConflict(error)) {
      const concurrent = await getEntryById(env.DB, id);
      if (concurrent?.status === 'uploading') {
        throw new HttpError(409, 'UPLOAD_IN_PROGRESS', 'An upload for this entry ID is already in progress');
      }
      throw new HttpError(409, 'ENTRY_ID_CONFLICT', 'Upload ID already exists');
    }
    throw entryNameConflict(error, name) ?? error;
  }

  const heartbeat = startUploadRecoveryHeartbeat(env.DB, operationId, owner, options.recoveryHeartbeat);
  try {
    try {
      const object = await env.R2_BUCKET.put(row.storage_key!, request.body, {
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
      });
      await heartbeat.touch();
      if (heartbeat.ownershipLost()) throw new Error('Upload recovery ownership was lost');
      const finalized = await finalizeUploadedEntry(env.DB, id, owner, {
        size: object.size,
        contentType: object.httpMetadata?.contentType ?? request.headers.get('content-type'),
        etag: object.httpEtag || object.etag,
      });
      if (!finalized) throw new Error('Upload entry was not available for finalization');
      await activateStorageRecoveryOperation(env.DB, operationId, 'completed').catch(() => undefined);
      const completed = await listStorageRecoveryOperations(env.DB, id);
      const completedOperation = completed.find((operation) => operation.id === operationId);
      if (completedOperation?.state === 'pending') {
        await reconcileStorageRecovery(env, { limit: 1 });
      }
    } catch (error) {
      await activateStorageRecoveryOperation(env.DB, operationId, 'cleanup_blob').catch(() => undefined);
      await reconcileStorageRecovery(env, { limit: 1 }).catch(() => undefined);
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Upload failed');
    }
  } finally {
    heartbeat.stop();
  }

  const ready = await getEntryById(env.DB, id);
  if (!ready || ready.status !== 'ready') throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Upload finalization failed');
  return entryToApi(ready, true, await isEffectivelyPublic(env.DB, id));
}

interface RecoveryResult {
  processed: number;
  completed: number;
  retried: number;
}

function parsePayload(payload: string): { deletedKeys?: string[] } {
  try {
    const parsed = JSON.parse(payload) as { deletedKeys?: unknown };
    return { deletedKeys: Array.isArray(parsed.deletedKeys) ? parsed.deletedKeys.filter((key): key is string => typeof key === 'string') : [] };
  } catch {
    return { deletedKeys: [] };
  }
}

async function recoverUploadCleanup(
  env: Env,
  operation: StorageRecoveryOperationRow,
  claimOwner: string,
  deleteBlob: (key: string) => Promise<void>,
  heartbeat: RecoveryClaimHeartbeat,
): Promise<'completed' | 'retried'> {
  const storageKey = operation.storage_key;
  if (!storageKey) {
    await heartbeat.touch();
    if (heartbeat.ownershipLost()) return 'retried';
    await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
    return 'completed';
  }
  const row = await getEntryById(env.DB, operation.entry_id);
  if (!row || row.status !== 'uploading' || row.lifecycle_owner !== operation.attempt_owner) {
    const currentOwner = await findEntryByStorageKey(env.DB, storageKey);
    if (currentOwner) {
      await heartbeat.touch();
      if (heartbeat.ownershipLost()) return 'retried';
      await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
      return 'completed';
    }
    try {
      await deleteBlob(storageKey);
      await heartbeat.touch();
      if (heartbeat.ownershipLost()) return 'retried';
      await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
      return 'completed';
    } catch (error) {
      if (heartbeat.ownershipLost()) return 'retried';
      await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, error);
      return 'retried';
    }
  }
  try {
    await deleteBlob(storageKey);
    await heartbeat.touch();
    if (heartbeat.ownershipLost()) return 'retried';
    if (!await updateClaimedStorageRecoveryOperation(env.DB, operation.id, claimOwner, 'delete_metadata', { deletedKeys: [storageKey] })) {
      await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, new Error('Recovery claim was lost'));
      return 'retried';
    }
    await deleteUploadingEntry(env.DB, row.id, operation.attempt_owner);
    await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
    return 'completed';
  } catch (error) {
    if (heartbeat.ownershipLost()) return 'retried';
    await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, error);
    return 'retried';
  }
}

async function recoverDeleteTree(
  env: Env,
  operation: StorageRecoveryOperationRow,
  claimOwner: string,
  maxBlobDeletes: number,
  deleteBlob: (key: string) => Promise<void>,
  heartbeat: RecoveryClaimHeartbeat,
): Promise<'completed' | 'retried'> {
  const rows = await listDescendantRows(env.DB, operation.entry_id);
  if (!rows.length || rows.some((row) => row.status !== 'deleting' || row.lifecycle_owner !== operation.attempt_owner)) {
    await heartbeat.touch();
    if (heartbeat.ownershipLost()) return 'retried';
    await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
    return 'completed';
  }

  const payload = parsePayload(operation.payload);
  const deleted = new Set(payload.deletedKeys);
  const files = rows.filter((row) => row.kind === 'file' && row.storage_key && !deleted.has(row.storage_key));
  try {
    for (const row of files.slice(0, maxBlobDeletes)) {
      await deleteBlob(row.storage_key!);
      deleted.add(row.storage_key!);
      await heartbeat.touch();
      if (heartbeat.ownershipLost()) return 'retried';
      if (!await updateClaimedStorageRecoveryOperation(env.DB, operation.id, claimOwner, 'delete_blobs', {
        deletedKeys: [...deleted],
      })) {
        await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, new Error('Recovery claim was lost'));
        return 'retried';
      }
    }
    if (files.length > maxBlobDeletes) {
      await heartbeat.touch();
      if (heartbeat.ownershipLost()) return 'retried';
      await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, new Error('Delete tree has remaining blobs'));
      return 'retried';
    }
    await heartbeat.touch();
    if (heartbeat.ownershipLost()) return 'retried';
    if (!await updateClaimedStorageRecoveryOperation(env.DB, operation.id, claimOwner, 'delete_metadata', { deletedKeys: [...deleted] })) {
      await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, new Error('Recovery claim was lost'));
      return 'retried';
    }
    for (const row of [...rows].reverse()) {
      const deletedRow = await deleteDeletingEntry(env.DB, row.id, operation.attempt_owner);
      if (!deletedRow) {
        const current = await getEntryById(env.DB, row.id);
        if (current && (current.status !== 'deleting' || current.lifecycle_owner !== operation.attempt_owner)) {
          await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
          return 'completed';
        }
      }
    }
    await completeStorageRecoveryOperation(env.DB, operation.id, claimOwner);
    return 'completed';
  } catch (error) {
    if (heartbeat.ownershipLost()) return 'retried';
    await retryStorageRecoveryOperation(env.DB, operation.id, claimOwner, error);
    return 'retried';
  }
}

export async function reconcileStorageRecovery(
  env: Env,
  options: {
    limit?: number;
    maxBlobDeletes?: number;
    workerOwner?: string;
    deleteBlob?: (key: string) => Promise<void>;
    now?: () => number;
    recoveryHeartbeat?: RecoveryClaimHeartbeatOptions;
  } = {},
): Promise<RecoveryResult> {
  const result: RecoveryResult = { processed: 0, completed: 0, retried: 0 };
  const workerOwner = options.workerOwner ?? crypto.randomUUID();
  const deleteBlob = options.deleteBlob ?? ((key: string) => env.R2_BUCKET.delete(key));
  const now = options.now ?? Date.now;
  const leaseDurationMs = 30_000;
  const operations = await listStorageRecoveryOperations(env.DB, undefined, options.limit ?? 20, now());
  for (const candidate of operations) {
    const operation = await claimStorageRecoveryOperation(env.DB, candidate.id, workerOwner, leaseDurationMs, now());
    if (!operation) continue;
    result.processed += 1;
    const heartbeat = startRecoveryClaimHeartbeat(env.DB, operation.id, workerOwner, leaseDurationMs, {
      ...options.recoveryHeartbeat,
      now,
    });
    let outcome: 'completed' | 'retried';
    try {
      outcome = operation.operation_kind === 'upload_cleanup'
        ? await recoverUploadCleanup(env, operation, workerOwner, deleteBlob, heartbeat)
        : await recoverDeleteTree(env, operation, workerOwner, options.maxBlobDeletes ?? 100, deleteBlob, heartbeat);
    } finally {
      heartbeat.stop();
    }
    if (outcome === 'completed') result.completed += 1;
    else result.retried += 1;
  }
  return result;
}

export async function deleteEntryTrees(
  env: Env,
  ids: string[],
  options: { maxEntries?: number; deleteBlob?: (key: string) => Promise<void> } = {},
): Promise<BatchResult> {
  const maxEntries = options.maxEntries ?? 1000;
  const result: BatchResult = { succeeded: [], failed: [] };

  for (const id of [...new Set(ids)]) {
    try {
      const target = await getEntryById(env.DB, id);
      if (!target || target.id === 'root' || target.status !== 'ready') {
        if (target?.status === 'deleting') {
          throw new HttpError(409, 'ENTRY_DELETE_IN_PROGRESS', 'Entry deletion is already in progress');
        }
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }
      if (await countDescendantRows(env.DB, id) > maxEntries) {
        throw new HttpError(409, 'OPERATION_LIMIT_EXCEEDED', 'Delete contains too many entries');
      }

      const owner = crypto.randomUUID();
      const operationId = `delete:${id}:${owner}`;
      if (!await enqueueStorageRecoveryOperation(env.DB, {
        id: operationId,
        entryId: id,
        operationKind: 'delete_tree',
        storageKey: null,
        attemptOwner: owner,
        phase: 'claim_tree',
        state: 'pending',
      })) {
        throw new HttpError(409, 'ENTRY_DELETE_IN_PROGRESS', 'Entry deletion is already in progress');
      }
      const claimed = await claimEntryTreeForDeletion(env.DB, id, owner);
      if (!claimed) {
        const current = await getEntryById(env.DB, id);
        if (current?.status === 'deleting' || current?.status === 'ready') {
          throw new HttpError(409, 'ENTRY_DELETE_IN_PROGRESS', 'Entry deletion is already in progress');
        }
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }

      await reconcileStorageRecovery(env, { limit: 20, maxBlobDeletes: maxEntries, deleteBlob: options.deleteBlob });
      const operation = (await listStorageRecoveryOperations(env.DB, id)).find((item) => item.id === operationId);
      if (operation?.state !== 'completed') {
        throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Storage deletion is pending recovery');
      }
      result.succeeded.push(id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'DELETE_FAILED', 'Delete failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }

  return result;
}
