import { matchesNameFilter } from './entry-domain';
import { listExternalDirectory, type ExternalDirectoryOptions } from './external-entries';
import { HttpError } from './http';
import { resolveVirtualPath } from './mount-resolver';
import { listMounts } from './mounts';
import type {
  Entry,
  EntryCapabilities,
  Env,
  Mount,
  MountEntry,
  VirtualDirectoryResponse,
} from './types';

const VIRTUAL_ROOT_ID = 'virtual-root';

const READ_ONLY_FOLDER_CAPABILITIES: EntryCapabilities = {
  open: true,
  preview: false,
  download: false,
  upload: false,
  multipartUpload: false,
  createFolder: false,
  rename: false,
  move: false,
  copy: false,
  delete: false,
  changeVisibility: false,
};

function virtualRootEntry(): Entry {
  return {
    id: VIRTUAL_ROOT_ID,
    parentId: null,
    name: 'iList',
    kind: 'folder',
    size: 0,
    contentType: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
    isPublic: true,
    effectivePublic: true,
    sortOrder: 0,
    description: '',
    mountPath: null,
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

export async function listVirtualDirectory(
  env: Env,
  pathname: string,
  admin: boolean,
  nameFilter: string | null = null,
  options: ExternalDirectoryOptions = {},
): Promise<VirtualDirectoryResponse> {
  const mounts = await listMounts(env.DB);
  if (pathname === '/') {
    return {
      current: virtualRootEntry(),
      breadcrumbs: [{ id: VIRTUAL_ROOT_ID, name: 'iList', path: '/' }],
      items: mounts
        .filter((mount) => mount.enabled && (admin || mount.isPublic))
        .filter((mount) => matchesNameFilter(mount.name, nameFilter))
        .map(mountEntry),
      nextCursor: null,
    };
  }

  const resolvableMounts = admin ? mounts : mounts.filter((mount) => mount.isPublic);
  const { mount, relativePath } = resolveVirtualPath(pathname, resolvableMounts);
  if (mount.driverType === 'native-r2' || mount.driverType === 'pikpak') {
    throw new HttpError(503, 'DRIVER_UNAVAILABLE', 'Storage driver is unavailable');
  }
  return listExternalDirectory(env, mount, relativePath, admin, nameFilter, options);
}
