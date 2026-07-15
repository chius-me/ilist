import { HttpError } from '../../http';
import type { Mount } from '../../types';
import type { DownloadResult, ListResult, StorageDriver, StorageItem } from '../types';
import type { GraphDriveItem, GraphListResult } from './client';
import { graphItemKind, mapGraphItem } from './mapper';

export interface OneDriveDriverClient {
  list(parentId: string, cursor?: string): Promise<GraphListResult>;
  stat(itemId: string): Promise<GraphDriveItem>;
}

function unsupported(): never {
  throw new HttpError(405, 'STORAGE_OPERATION_UNSUPPORTED', 'OneDrive write operations are not enabled');
}

export class OneDriveDriver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download'] as const);
  readonly rootId: string;

  constructor(private readonly mount: Mount, private readonly client: OneDriveDriverClient) {
    this.rootId = mount.rootItemId ?? 'root';
  }

  async list(parentId: string, cursor?: string): Promise<ListResult> {
    const result = await this.client.list(parentId, cursor);
    return { items: result.items.map((item) => mapGraphItem(item, parentId)), nextCursor: result.nextCursor };
  }

  async stat(itemId: string): Promise<StorageItem> {
    const item = await this.client.stat(itemId);
    return mapGraphItem(item, null);
  }

  async getDownload(itemId: string, _request: Request): Promise<DownloadResult> {
    const item = await this.client.stat(itemId);
    if (graphItemKind(item) !== 'file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');
    const url = item['@microsoft.graph.downloadUrl'];
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new HttpError(502, 'ONEDRIVE_DOWNLOAD_UNAVAILABLE', 'OneDrive download is unavailable');
    }
    return { kind: 'redirect', url };
  }

  async createFolder(_parentId: string, _name: string): Promise<StorageItem> { return unsupported(); }
  async upload(_parentId: string, _name: string, _body: ReadableStream, _contentType: string | null): Promise<StorageItem> { return unsupported(); }
  async rename(_itemId: string, _name: string): Promise<StorageItem> { return unsupported(); }
  async move(_itemId: string, _destinationId: string): Promise<StorageItem> { return unsupported(); }
  async remove(_itemId: string): Promise<void> { return unsupported(); }
}
