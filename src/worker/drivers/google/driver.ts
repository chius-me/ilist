import { HttpError } from '../../http';
import type { Mount } from '../../types';
import type { DownloadResult, ListResult, StorageDriver, StorageItem } from '../types';
import type { GoogleFile, GoogleListResult } from './client';
import { GoogleDriveClient } from './client';
import { isGoogleNativeFile, mapGoogleFile } from './items';

export interface GoogleDriveDriverClient {
  list(parentId: string, cursor?: string): Promise<GoogleListResult>;
  stat(itemId: string): Promise<GoogleFile>;
  download(itemId: string, range?: string | null): Promise<Response>;
  exportFile(itemId: string, contentType: string): Promise<Response>;
  createFolder(parentId: string, name: string): Promise<GoogleFile>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<GoogleFile>;
  rename(itemId: string, name: string): Promise<GoogleFile>;
  move(itemId: string, destinationId: string): Promise<GoogleFile>;
  trash(itemId: string): Promise<GoogleFile>;
}

function validName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || normalized.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Storage item name is invalid');
  return normalized;
}

export class GoogleDriveDriver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download', 'upload', 'createFolder', 'rename', 'move', 'delete'] as const);
  readonly rootId: string;

  constructor(private readonly mount: Mount, private readonly client: GoogleDriveDriverClient) {
    this.rootId = mount.rootItemId ?? 'root';
  }

  async list(parentId: string, cursor?: string): Promise<ListResult> {
    await this.assertInScope(parentId);
    const result = await this.client.list(parentId, cursor);
    return {
      items: result.items
        .filter((item) => !item.trashed)
        .map((item) => ({ ...mapGoogleFile(item, parentId), parentId })),
      nextCursor: result.nextCursor,
    };
  }

  async stat(itemId: string): Promise<StorageItem> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    const mapped = mapGoogleFile(item, null);
    return itemId === this.rootId ? { ...mapped, id: this.rootId, parentId: null } : mapped;
  }

  async getDownload(itemId: string, request: Request): Promise<DownloadResult> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    const mapped = mapGoogleFile(item, null);
    if (mapped.kind !== 'file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');

    const requestedFormat = new URL(request.url).searchParams.get('export');
    if (mapped.exportOptions?.length) {
      if (!requestedFormat) throw new HttpError(400, 'GOOGLE_EXPORT_REQUIRED', 'A Google Workspace export format is required');
      const option = mapped.exportOptions.find((candidate) => candidate.format === requestedFormat);
      if (!option) throw new HttpError(400, 'GOOGLE_EXPORT_UNSUPPORTED', 'Google Workspace export format is unsupported');
      return { kind: 'stream', response: await this.client.exportFile(itemId, option.contentType) };
    }
    if (requestedFormat || isGoogleNativeFile(item.mimeType)) {
      throw new HttpError(400, 'GOOGLE_EXPORT_UNSUPPORTED', 'Google Workspace export format is unsupported');
    }
    return { kind: 'stream', response: await this.client.download(itemId, request.headers.get('range')) };
  }

  async createFolder(parentId: string, name: string): Promise<StorageItem> {
    await this.assertInScope(parentId);
    return { ...mapGoogleFile(await this.client.createFolder(parentId, validName(name)), parentId), parentId };
  }

  async upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<StorageItem> {
    await this.assertInScope(parentId);
    return { ...mapGoogleFile(await this.client.upload(parentId, validName(name), body, contentType), parentId), parentId };
  }

  async rename(itemId: string, name: string): Promise<StorageItem> {
    this.assertMutable(itemId, 'renamed');
    await this.assertInScope(itemId);
    return mapGoogleFile(await this.client.rename(itemId, validName(name)), null);
  }

  async move(itemId: string, destinationId: string): Promise<StorageItem> {
    this.assertMutable(itemId, 'moved');
    await this.assertInScope(itemId);
    await this.assertInScope(destinationId);
    return { ...mapGoogleFile(await this.client.move(itemId, destinationId), destinationId), parentId: destinationId };
  }

  async remove(itemId: string): Promise<void> {
    this.assertMutable(itemId, 'deleted');
    await this.assertInScope(itemId);
    await this.client.trash(itemId);
  }

  private assertMutable(itemId: string, operation: string): void {
    if (itemId === this.rootId) {
      throw new HttpError(400, 'INVALID_STORAGE_OPERATION', `Mount root cannot be ${operation}`);
    }
  }

  private async assertInScope(itemId: string, knownItem?: GoogleFile): Promise<void> {
    if (this.rootId === 'root' || itemId === this.rootId) return;
    let item = knownItem ?? await this.client.stat(itemId);
    const visited = new Set([itemId]);
    for (let depth = 0; depth < 256; depth += 1) {
      const parentId = item.parents?.[0];
      if (parentId === this.rootId) return;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      item = await this.client.stat(parentId);
    }
    throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Google Drive item was not found');
  }
}

export function createGoogleDriveDriver(env: import('../../types').Env, mount: Mount): GoogleDriveDriver {
  return new GoogleDriveDriver(mount, new GoogleDriveClient(env, mount.id));
}
