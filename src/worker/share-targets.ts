import { getEntryById, listChildRows } from './db';
import { createDriver, driverRegistry } from './drivers/registry';
import type { DriverRegistry, StorageDriver, StorageItem } from './drivers/types';
import { decodeExternalId } from './external-identity';
import { HttpError } from './http';
import { getMount } from './mounts';
import { streamEntryObject } from './r2';
import { openShareItem, sealShareItem } from './share-crypto';
import type { DirectoryResponse, Entry, EntryCapabilities, EntryRow, Env, Mount, Share } from './types';

const MAX_LIST_PAGES = 100;

export interface ShareTarget {
  mountId: string;
  providerItemId: string;
  targetKind: 'file' | 'folder';
  name: string;
}

export interface ResolvedSharedItem {
  mount: Mount;
  driver: StorageDriver | null;
  item: StorageItem;
  nativeRow: EntryRow | null;
  entry: Entry;
}

function targetMissing(): HttpError {
  return new HttpError(404, 'SHARE_TARGET_MISSING', 'Shared item is unavailable');
}

function providerUnavailable(): HttpError {
  return new HttpError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Shared storage is unavailable');
}

function nativeItem(row: EntryRow): StorageItem {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    size: row.kind === 'file' ? row.size : null,
    contentType: row.content_type,
    modifiedAt: row.updated_at,
    etag: row.etag,
  };
}

function sharedCapabilities(item: StorageItem, allowDownload: boolean): EntryCapabilities {
  const file = item.kind === 'file';
  return {
    open: item.kind === 'folder',
    preview: file,
    download: file && allowDownload,
    upload: false,
    multipartUpload: false,
    createFolder: false,
    rename: false,
    move: false,
    delete: false,
    changeVisibility: false,
  };
}

async function sharedEntry(env: Env, share: Share, item: StorageItem, root = false): Promise<Entry> {
  return {
    id: await sealShareItem(env, share.id, item.id),
    parentId: null,
    name: root ? share.name : item.name,
    kind: item.kind,
    size: item.size ?? 0,
    contentType: item.contentType,
    updatedAt: item.modifiedAt ?? share.updatedAt,
    isPublic: false,
    effectivePublic: false,
    sortOrder: 0,
    description: '',
    mountPath: null,
    exportOptions: item.exportOptions?.map((option) => ({ ...option })),
    capabilities: sharedCapabilities(item, share.allowDownload),
  };
}

async function requireMount(env: Env, id: string): Promise<Mount> {
  const mount = await getMount(env.DB, id);
  if (!mount) throw targetMissing();
  if (!mount.enabled) throw providerUnavailable();
  return mount;
}

async function externalDriver(
  env: Env,
  mount: Mount,
  registry: DriverRegistry,
): Promise<StorageDriver> {
  try {
    return await createDriver(env, mount, registry);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'MOUNT_DISABLED') throw providerUnavailable();
    throw error;
  }
}

async function statExternal(driver: StorageDriver, itemId: string): Promise<StorageItem> {
  try {
    return await driver.stat(itemId);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403 || error.status >= 500)) throw error;
    throw targetMissing();
  }
}

export async function resolveShareCreationTarget(
  env: Env,
  entryId: string,
  registry: DriverRegistry = driverRegistry,
): Promise<ShareTarget> {
  const identity = decodeExternalId(entryId);
  if (identity) {
    const mount = await requireMount(env, identity.mountId);
    const driver = await externalDriver(env, mount, registry);
    const item = await statExternal(driver, identity.itemId);
    return { mountId: mount.id, providerItemId: item.id, targetKind: item.kind, name: item.name };
  }

  const directMount = await getMount(env.DB, entryId);
  if (directMount) {
    if (!directMount.enabled) throw providerUnavailable();
    if (directMount.driverType === 'native-r2') {
      const row = await getEntryById(env.DB, 'root');
      if (!row || row.status !== 'ready') throw targetMissing();
      return { mountId: directMount.id, providerItemId: row.id, targetKind: 'folder', name: directMount.name };
    }
    const driver = await externalDriver(env, directMount, registry);
    const item = await statExternal(driver, driver.rootId);
    return { mountId: directMount.id, providerItemId: item.id, targetKind: item.kind, name: directMount.name };
  }

  const row = await getEntryById(env.DB, entryId);
  if (!row || row.status !== 'ready') throw targetMissing();
  const mount = await requireMount(env, 'native-r2');
  return { mountId: mount.id, providerItemId: row.id, targetKind: row.kind, name: row.name };
}

export async function resolveSharedItem(
  env: Env,
  share: Share,
  handle: string | null,
  registry: DriverRegistry = driverRegistry,
): Promise<ResolvedSharedItem> {
  const mount = await requireMount(env, share.mountId);
  const itemId = handle ? await openShareItem(env, share.id, handle) : share.providerItemId;
  if (mount.driverType === 'native-r2') {
    const row = await getEntryById(env.DB, itemId);
    if (!row || row.status !== 'ready') throw targetMissing();
    const item = nativeItem(row);
    return { mount, driver: null, item, nativeRow: row, entry: await sharedEntry(env, share, item, item.id === share.providerItemId) };
  }
  const driver = await externalDriver(env, mount, registry);
  const item = await statExternal(driver, itemId);
  return { mount, driver, item, nativeRow: null, entry: await sharedEntry(env, share, item, item.id === share.providerItemId) };
}

async function listAll(driver: StorageDriver, parentId: string): Promise<StorageItem[]> {
  const items: StorageItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await driver.list(parentId, cursor);
    items.push(...result.items);
    if (!result.nextCursor) return items;
    cursor = result.nextCursor;
  }
  throw new HttpError(502, 'SHARE_PROVIDER_UNAVAILABLE', 'Shared storage is unavailable');
}

export async function listSharedFolder(
  env: Env,
  share: Share,
  handle: string | null,
  registry: DriverRegistry = driverRegistry,
): Promise<DirectoryResponse> {
  const current = await resolveSharedItem(env, share, handle, registry);
  if (current.item.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'Shared item is not a folder');
  const items = current.nativeRow
    ? (await listChildRows(env.DB, current.nativeRow.id)).filter((row) => row.status === 'ready').map(nativeItem)
    : await listAll(current.driver!, current.item.id);
  const entries = await Promise.all(items.map((item) => sharedEntry(env, share, item)));
  return {
    current: current.entry,
    breadcrumbs: [{ id: current.entry.id, name: current.entry.name, path: handle ?? '' }],
    items: entries,
  };
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function downloadSharedFile(
  env: Env,
  share: Share,
  handle: string,
  request: Request,
  download: boolean,
  registry: DriverRegistry = driverRegistry,
): Promise<Response> {
  const resolved = await resolveSharedItem(env, share, handle, registry);
  if (resolved.item.kind !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Shared item is not a file');
  if (resolved.nativeRow) {
    return privateResponse(await streamEntryObject(env.R2_BUCKET, resolved.nativeRow, request, {
      download,
      publicFile: false,
    }));
  }
  const result = await resolved.driver!.getDownload(resolved.item.id, request);
  if (result.kind === 'stream') {
    return privateResponse(new Response(request.method === 'HEAD' ? null : result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
    }));
  }
  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) headers.set('range', range);
  return privateResponse(await fetch(result.url, { method: request.method, headers, redirect: 'follow' }));
}
