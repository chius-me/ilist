import { createDriver, driverRegistry } from './drivers/registry';
import type { DriverRegistry, StorageDriver, StorageItem } from './drivers/types';
import { decodeExternalId } from './external-identity';
import {
  INLINE_CONTENT_TYPES,
  isTextPreviewContentType,
  normalizeContentType,
  secureFileResponse,
  TEXT_PREVIEW_MAX_BYTES,
} from './file-response-security';
import { HttpError } from './http';
import { getMount } from './mounts';
import { openShareItem, sealShareItem } from './share-crypto';
import { canDownloadFromShare } from './share-policy';
import type { DirectoryResponse, Entry, EntryCapabilities, Env, FileExportOption, Mount, Share } from './types';

const MAX_LIST_PAGES = 100;
const RETIRED_DRIVERS = new Set(['native-r2', 'pikpak']);
const SAFE_TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'log', 'css', 'js', 'ts', 'tsx', 'jsx',
  'xml', 'csv', 'toml', 'scss', 'py', 'go', 'rs', 'sh', 'sql', 'ini',
]);

export interface ShareTarget {
  mountId: string;
  providerItemId: string;
  targetKind: 'file' | 'folder';
  name: string;
}

export interface ResolvedSharedItem {
  mount: Mount;
  driver: StorageDriver;
  item: StorageItem;
  entry: Entry;
}

function targetMissing(): HttpError {
  return new HttpError(404, 'SHARE_TARGET_MISSING', 'Shared item is unavailable');
}

function providerUnavailable(): HttpError {
  return new HttpError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Shared storage is unavailable');
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
    copy: false,
    delete: false,
    changeVisibility: false,
  };
}

async function sharedEntry(env: Env, share: Share, item: StorageItem, root = false): Promise<Entry> {
  return {
    id: await sealShareItem(env, share.id, share.providerItemId, item.id),
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
    capabilities: sharedCapabilities(item, canDownloadFromShare(share)),
  };
}

async function requireMount(env: Env, id: string): Promise<Mount> {
  const mount = await getMount(env.DB, id);
  if (!mount) throw targetMissing();
  if (!mount.enabled || RETIRED_DRIVERS.has(mount.driverType)) throw providerUnavailable();
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
    if (error instanceof HttpError && (error.code === 'MOUNT_DISABLED' || error.code === 'DRIVER_UNAVAILABLE')) {
      throw providerUnavailable();
    }
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

export function isAllowedInlinePreview(
  item: Pick<StorageItem, 'name' | 'contentType' | 'size'>,
  exportOption: FileExportOption | undefined,
  sandboxedPreview: boolean,
): boolean {
  if (exportOption) {
    return sandboxedPreview && exportOption.contentType === 'application/pdf';
  }
  const sourceType = normalizeContentType(item.contentType);
  if (sourceType === 'text/html' || sourceType === 'image/svg+xml') return false;
  if (sourceType && INLINE_CONTENT_TYPES.has(sourceType)) return true;

  const extension = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (sourceType === 'application/pdf' || (!sourceType && extension === 'pdf')) {
    return sandboxedPreview;
  }
  if ((sourceType && isTextPreviewContentType(sourceType)) || (!sourceType && SAFE_TEXT_EXTENSIONS.has(extension))) {
    return item.size === null || item.size <= TEXT_PREVIEW_MAX_BYTES;
  }
  return false;
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
    if (!directMount.enabled || RETIRED_DRIVERS.has(directMount.driverType)) throw providerUnavailable();
    const driver = await externalDriver(env, directMount, registry);
    const item = await statExternal(driver, driver.rootId);
    return { mountId: directMount.id, providerItemId: item.id, targetKind: item.kind, name: directMount.name };
  }

  throw targetMissing();
}

export async function resolveSharedItem(
  env: Env,
  share: Share,
  handle: string | null,
  registry: DriverRegistry = driverRegistry,
): Promise<ResolvedSharedItem> {
  const mount = await requireMount(env, share.mountId);
  const opened = handle
    ? await openShareItem(env, share.id, handle)
    : { rootItemId: share.providerItemId, itemId: share.providerItemId };
  if (opened.rootItemId !== null && opened.rootItemId !== share.providerItemId) throw targetMissing();
  const itemId = opened.itemId;
  const driver = await externalDriver(env, mount, registry);
  if (!await driver.isWithin(itemId, share.providerItemId)) throw targetMissing();
  const item = await statExternal(driver, itemId);
  return { mount, driver, item, entry: await sharedEntry(env, share, item, item.id === share.providerItemId) };
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
  const items = await listAll(current.driver, current.item.id);
  const entries = await Promise.all(items.map((item) => sharedEntry(env, share, item)));
  return {
    current: current.entry,
    breadcrumbs: [{ id: current.entry.id, name: current.entry.name, path: handle ?? '' }],
    items: entries,
  };
}

function mapUpstreamStatusError(status: number): HttpError {
  if (status === 404) return targetMissing();
  if (status === 416) return new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'Requested byte range is invalid');
  return providerUnavailable();
}

export async function downloadSharedFile(
  env: Env,
  share: Share,
  target: string | ResolvedSharedItem,
  request: Request,
  download: boolean,
  registry: DriverRegistry = driverRegistry,
): Promise<Response> {
  const resolved = typeof target === 'string'
    ? await resolveSharedItem(env, share, target, registry)
    : target;
  if (resolved.item.kind !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Shared item is not a file');

  const requestUrl = new URL(request.url);
  const sandboxedPreview = requestUrl.searchParams.get('preview') === '1';
  const requestedExport = requestUrl.searchParams.get('export');
  const exportOption = requestedExport
    ? resolved.item.exportOptions?.find((option) => option.format === requestedExport)
    : undefined;

  const result = await resolved.driver.getDownload(resolved.item.id, request);
  const options = {
    filename: exportOption ? `${resolved.item.name}.${exportOption.extension}` : resolved.item.name,
    contentType: exportOption?.contentType ?? resolved.item.contentType,
    download,
    sandboxedPreview,
    publicFile: false,
    method: request.method,
    https: requestUrl.protocol === 'https:',
  };

  let upstream: Response;
  if (result.kind === 'stream') {
    upstream = result.response;
  } else {
    const headers = new Headers();
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    try {
      upstream = await fetch(result.url, { method: request.method, headers, redirect: 'follow' });
    } catch {
      throw providerUnavailable();
    }
  }

  if (!upstream.ok && upstream.status !== 304) {
    void upstream.body?.cancel();
    throw mapUpstreamStatusError(upstream.status);
  }
  return secureFileResponse(upstream, options);
}
