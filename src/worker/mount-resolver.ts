import { HttpError } from './http';
import type { Mount } from './types';

export interface ResolvedVirtualPath {
  mount: Mount;
  relativePath: string;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Mount was not found');
  }
}

export function resolveVirtualPath(virtualPath: string, mounts: readonly Mount[]): ResolvedVirtualPath {
  if (!virtualPath.startsWith('/')) {
    throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Mount was not found');
  }

  const segments = virtualPath.slice(1).split('/');
  const mountSegment = decodeSegment(segments[0]);
  const mount = mounts.find((candidate) => candidate.mountPath.slice(1) === mountSegment);
  if (!mount) {
    throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Mount was not found');
  }
  if (!mount.enabled) {
    throw new HttpError(403, 'MOUNT_DISABLED', 'Mount is disabled');
  }

  const relativeSegments = segments.slice(1).map(decodeSegment);
  return {
    mount,
    relativePath: relativeSegments.length === 0 ? '/' : `/${relativeSegments.join('/')}`,
  };
}
