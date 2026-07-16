import { createDriver } from './drivers/registry';
import { requireResumableUploadAdapter, type StorageDriver, type StorageItem } from './drivers/types';
import { encodeExternalId, decodeExternalId, type ExternalIdentity } from './external-identity';
import { HttpError } from './http';
import { getMount } from './mounts';
import type { Breadcrumb, Env, Mount, MountEntry, VirtualDirectoryResponse } from './types';

const MAX_LIST_PAGES = 100;

function capabilities(driver: StorageDriver, item: StorageItem, admin: boolean) {
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
    driverType: mount.driverType,
    provider: mount.provider,
    capabilities: capabilities(driver, item, admin),
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

export async function listExternalDirectory(
  env: Env,
  mount: Mount,
  relativePath: string,
  admin: boolean,
): Promise<VirtualDirectoryResponse> {
  const driver = await createDriver(env, mount);
  const segments = relativePath === '/' ? [] : relativePath.slice(1).split('/');
  let current = await driver.stat(driver.rootId);
  const mountPath = encodedMountPath(mount);
  const breadcrumbs: Breadcrumb[] = [
    { id: 'virtual-root', name: 'ilist', path: '/' },
    { id: encodeExternalId(mount.id, driver.rootId), name: mount.name, path: mountPath },
  ];
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

  if (current.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'Entry is not a folder');
  return {
    current: externalEntry(current, mount, driver, admin),
    breadcrumbs,
    items: (await listAll(driver, current.id)).map((entry) => externalEntry(entry, mount, driver, admin)),
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
