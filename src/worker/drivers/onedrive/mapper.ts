import { HttpError } from '../../http';
import type { StorageItem } from '../types';
import type { GraphDriveItem } from './client';

export function hasSupportedGraphItemType(item: GraphDriveItem): boolean {
  return Boolean(item.folder || item.package || item.root || item.specialFolder || item.file);
}

export function graphItemKind(item: GraphDriveItem): 'file' | 'folder' {
  if (item.folder || item.package || item.root || item.specialFolder) return 'folder';
  if (item.file) return 'file';
  console.error('OneDrive item has no supported type facet', {
    id: item.id,
    name: item.name,
    fields: Object.keys(item).filter((key) => key !== '@microsoft.graph.downloadUrl').sort(),
  });
  throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive item type is invalid');
}

export function mapGraphItem(item: GraphDriveItem, fallbackParentId: string | null): StorageItem {
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') {
    throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive item is invalid');
  }
  const kind = graphItemKind(item);
  return {
    id: item.id,
    parentId: item.parentReference?.id ?? fallbackParentId,
    name: item.name,
    kind,
    size: kind === 'folder' ? null : typeof item.size === 'number' ? item.size : null,
    contentType: kind === 'file' && typeof item.file?.mimeType === 'string' ? item.file.mimeType : null,
    modifiedAt: typeof item.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : null,
    etag: typeof item.eTag === 'string' ? item.eTag : typeof item.cTag === 'string' ? item.cTag : null,
  };
}
