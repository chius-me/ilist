import { HttpError } from '../../http';
import type { Mount } from '../../types';
import type { DownloadResult, ListResult, StorageDriver, StorageItem } from '../types';
import type { GraphDriveItem, GraphItemUpdate, GraphListResult } from './client';
import { graphItemKind, hasSupportedGraphItemType, mapGraphItem } from './mapper';

export interface OneDriveDriverClient {
  list(parentId: string, cursor?: string): Promise<GraphListResult>;
  stat(itemId: string): Promise<GraphDriveItem>;
  getDownloadUrl(itemId: string): Promise<string>;
  createFolder(parentId: string, name: string): Promise<GraphDriveItem>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<GraphDriveItem>;
  update(itemId: string, update: GraphItemUpdate): Promise<GraphDriveItem>;
  remove(itemId: string): Promise<void>;
}

function validName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/') || normalized.includes('\\') || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Storage item name is invalid');
  }
  return normalized;
}

export class OneDriveDriver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download', 'upload', 'createFolder', 'rename', 'move', 'delete'] as const);
  readonly rootId: string;

  constructor(private readonly mount: Mount, private readonly client: OneDriveDriverClient) {
    this.rootId = mount.rootItemId ?? 'root';
  }

  async list(parentId: string, cursor?: string): Promise<ListResult> {
    await this.assertInScope(parentId);
    const result = await this.client.list(parentId, cursor);
    return {
      items: result.items.filter(hasSupportedGraphItemType).map((item) => mapGraphItem(item, parentId)),
      nextCursor: result.nextCursor,
    };
  }

  async stat(itemId: string): Promise<StorageItem> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    return mapGraphItem(item, null);
  }

  async getDownload(itemId: string, _request: Request): Promise<DownloadResult> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    if (graphItemKind(item) !== 'file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');
    return { kind: 'redirect', url: await this.client.getDownloadUrl(itemId) };
  }

  async createFolder(parentId: string, name: string): Promise<StorageItem> {
    await this.assertInScope(parentId);
    return mapGraphItem(await this.client.createFolder(parentId, validName(name)), parentId);
  }

  async upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<StorageItem> {
    await this.assertInScope(parentId);
    return mapGraphItem(await this.client.upload(parentId, validName(name), body, contentType), parentId);
  }

  async rename(itemId: string, name: string): Promise<StorageItem> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be renamed');
    await this.assertInScope(itemId);
    return mapGraphItem(await this.client.update(itemId, { name: validName(name) }), null);
  }

  async move(itemId: string, destinationId: string): Promise<StorageItem> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be moved');
    await this.assertInScope(itemId);
    await this.assertInScope(destinationId);
    return mapGraphItem(await this.client.update(itemId, { parentReference: { id: destinationId } }), destinationId);
  }

  async remove(itemId: string): Promise<void> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be deleted');
    await this.assertInScope(itemId);
    await this.client.remove(itemId);
  }

  private async assertInScope(itemId: string, knownItem?: GraphDriveItem): Promise<void> {
    if (this.rootId === 'root' || itemId === this.rootId) return;
    let item = knownItem ?? await this.client.stat(itemId);
    const visited = new Set([itemId]);
    for (let depth = 0; depth < 256; depth += 1) {
      const parentId = item.parentReference?.id;
      if (parentId === this.rootId) return;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      item = await this.client.stat(parentId);
    }
    throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'OneDrive item was not found');
  }
}
