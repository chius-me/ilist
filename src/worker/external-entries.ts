import { createDriver } from './drivers/registry';
import { requireResumableUploadAdapter, type StorageDriver, type StorageItem } from './drivers/types';
import { matchesNameFilter } from './entry-domain';
import { decodeExternalId, encodeExternalId, type ExternalIdentity } from './external-identity';
import { HttpError } from './http';
import { getMount } from './mounts';
import type { Breadcrumb, Env, Mount, MountEntry, VirtualDirectoryResponse } from './types';

const MAX_LIST_PAGES = 100;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1000;

export interface ExternalDirectoryOptions {
  cursor?: string | null;
  limit?: number | null;
}

function normalizedLimit(limit: number | null | undefined): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(limit, MAX_PAGE_LIMIT);
}

function canCopyItem(driver: StorageDriver, item: StorageItem, mount: Mount): boolean {
  if (!driver.capabilities.has('copy') || item.id === driver.rootId) return false;
  // Google Workspace-native files only export; they are not binary-copyable.
  if (item.exportOptions?.length) return false;
  // OneDrive/Google implement file copy only; S3 and Dropbox support folder trees.
  if (item.kind === 'folder') return mount.driverType === 's3' || mount.driverType === 'dropbox';
  return item.kind === 'file';
}

function capabilities(driver: StorageDriver, item: StorageItem, admin: boolean, mount: Mount) {
  const folder = item.kind === 'folder';
  const file = item.kind === 'file';
  return {
    open: folder && driver.capabilities.has('list'),
    preview: file && driver.capabilities.has('download'),
    download: file && driver.capabilities.has('download'),
    upload: admin && folder && driver.capabilities.has('upload'),
    multipartUpload: admin && folder && driver.capabilities.has('upload') && requireResumableUploadAdapter(driver),
    createFolder: admin && folder && driver.capabilities.has('createFolder'),
    rename: admin && item.id !== driver.rootId && driver.capabilities.has('rename'),
    move: admin && item.id !== driver.rootId && driver.capabilities.has('move'),
    copy: admin && canCopyItem(driver, item, mount),
    delete: admin && item.id !== driver.rootId && driver.capabilities.has('delete'),
    changeVisibility: false,
  };
}

export function externalEntry(item: StorageItem, mount: Mount, driver: StorageDriver, admin: boolean): MountEntry {
  return {
    id: encodeExternalId(mount.id, item.id),
    parentId: item.id === driver.rootId ? null : item.parentId ? encodeExternalId(mount.id, item.parentId) : null,
    name: item.id === driver.rootId ? mount.name : item.name,
    kind: item.kind,
    size: item.size ?? 0,
    contentType: item.contentType,
    updatedAt: item.modifiedAt ?? mount.updatedAt,
    isPublic: mount.isPublic,
    effectivePublic: mount.isPublic,
    sortOrder: 0,
    description: '',
    mountId: mount.id,
    mountPath: mount.mountPath,
    exportOptions: item.exportOptions?.map((option) => ({ ...option })),
    driverType: mount.driverType,
    provider: mount.provider,
    capabilities: capabilities(driver, item, admin, mount),
  };
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
  throw new HttpError(502, 'PROVIDER_PAGINATION_LIMIT', 'Storage provider returned too many pages');
}

function encodedMountPath(mount: Mount): string {
  return `/${encodeURIComponent(mount.mountPath.slice(1))}`;
}

async function resolveDirectoryChain(
  driver: StorageDriver,
  mount: Mount,
  segments: string[],
): Promise<{ current: StorageItem; breadcrumbs: Breadcrumb[] }> {
  const mountPath = encodedMountPath(mount);
  const breadcrumbs: Breadcrumb[] = [
    { id: 'virtual-root', name: 'iList', path: '/' },
    { id: encodeExternalId(mount.id, driver.rootId), name: mount.name, path: mountPath },
  ];

  if (segments.length > 0 && driver.resolvePath) {
    const chain = await driver.resolvePath(segments);
    const current = chain[chain.length - 1];
    if (!current) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    const pathSegments: string[] = [];
    for (let index = 1; index < chain.length; index += 1) {
      const item = chain[index]!;
      pathSegments.push(segments[index - 1] ?? item.name);
      breadcrumbs.push({
        id: encodeExternalId(mount.id, item.id),
        name: item.name,
        path: `${mountPath}/${pathSegments.map(encodeURIComponent).join('/')}`,
      });
    }
    return { current, breadcrumbs };
  }

  let current = await driver.stat(driver.rootId);
  const pathSegments: string[] = [];
  for (const segment of segments) {
    const child = (await listAll(driver, current.id)).find((entry) => entry.kind === 'folder' && entry.name === segment);
    if (!child) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    current = child;
    pathSegments.push(segment);
    breadcrumbs.push({
      id: encodeExternalId(mount.id, child.id),
      name: child.name,
      path: `${mountPath}/${pathSegments.map(encodeURIComponent).join('/')}`,
    });
  }
  return { current, breadcrumbs };
}

export async function listExternalDirectory(
  env: Env,
  mount: Mount,
  relativePath: string,
  admin: boolean,
  nameFilter: string | null = null,
  options: ExternalDirectoryOptions = {},
): Promise<VirtualDirectoryResponse> {
  const driver = await createDriver(env, mount);
  const segments = relativePath.split('/').filter(Boolean);
  const { current, breadcrumbs } = await resolveDirectoryChain(driver, mount, segments);

  if (current.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'Entry is not a folder');

  if (nameFilter) {
    return {
      current: externalEntry(current, mount, driver, admin),
      breadcrumbs,
      items: (await listAll(driver, current.id))
        .filter((entry) => matchesNameFilter(entry.name, nameFilter))
        .map((entry) => externalEntry(entry, mount, driver, admin)),
      nextCursor: null,
    };
  }

  const page = await driver.list(
    current.id,
    options.cursor ?? undefined,
    normalizedLimit(options.limit),
  );
  return {
    current: externalEntry(current, mount, driver, admin),
    breadcrumbs,
    items: page.items.map((entry) => externalEntry(entry, mount, driver, admin)),
    nextCursor: page.nextCursor,
  };
}

export interface ResolvedExternalEntry {
  identity: ExternalIdentity;
  mount: Mount;
  driver: StorageDriver;
  item: StorageItem;
  entry: MountEntry;
}

export async function resolveExternalEntry(env: Env, id: string, admin: boolean): Promise<ResolvedExternalEntry | null> {
  const identity = decodeExternalId(id);
  if (!identity) return null;
  const mount = await getMount(env.DB, identity.mountId);
  if (!mount || !mount.enabled || (!admin && !mount.isPublic)) {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  }
  const driver = await createDriver(env, mount);
  const item = await driver.stat(identity.itemId);
  return { identity, mount, driver, item, entry: externalEntry(item, mount, driver, admin) };
}

export function requireExternalCapability(driver: StorageDriver, capability: Parameters<StorageDriver['capabilities']['has']>[0]): void {
  if (!driver.capabilities.has(capability)) {
    throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'Storage driver does not support this operation');
  }
}
