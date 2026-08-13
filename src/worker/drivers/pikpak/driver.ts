import { HttpError } from '../../http';
import type { Mount } from '../../types';
import type { DownloadResult, DriverCapability, ListResult, StorageDriver, StorageItem } from '../types';
import type { PikPakClient } from './client';
import type { PikPakFile } from './types';

function validName(name: string): string {
  const value = name.trim();
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Storage item name is invalid');
  }
  return value;
}

function size(value: string | number | undefined): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function mapFile(file: PikPakFile, fallbackParent: string | null): StorageItem {
  if (!file.id || !file.name || (file.kind !== 'drive#file' && file.kind !== 'drive#folder')) {
    throw new HttpError(502, 'PIKPAK_UPSTREAM_INVALID', 'PikPak response was invalid');
  }
  return {
    id: file.id,
    parentId: file.parent_id || fallbackParent,
    name: file.name,
    kind: file.kind === 'drive#folder' ? 'folder' : 'file',
    size: file.kind === 'drive#folder' ? null : size(file.size),
    contentType: file.kind === 'drive#file' && typeof file.mime_type === 'string' ? file.mime_type : null,
    modifiedAt: typeof file.modified_time === 'string' ? file.modified_time : null,
    etag: null,
  };
}

export class PikPakDriver implements StorageDriver {
  readonly capabilities: ReadonlySet<DriverCapability> = new Set(['list', 'download', 'createFolder', 'rename', 'move', 'delete']);
  readonly rootId: string;
  private readonly useTrash: boolean;

  constructor(private readonly mount: Mount, private readonly client: PikPakClient) {
    this.rootId = mount.rootItemId ?? 'root';
    this.useTrash = !(typeof mount.config === 'object' && mount.config !== null && (mount.config as Record<string, unknown>).useTrash === false);
  }

  async list(parentId: string, cursor?: string): Promise<ListResult> {
    await this.assertInScope(parentId);
    const result = await this.client.list(parentId, cursor);
    if (result.files !== undefined && !Array.isArray(result.files)) throw new HttpError(502, 'PIKPAK_UPSTREAM_INVALID', 'PikPak response was invalid');
    return { items: (result.files ?? []).map((item) => mapFile(item, parentId)), nextCursor: result.next_page_token ?? null };
  }

  async stat(itemId: string): Promise<StorageItem> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    return mapFile(item, null);
  }

  isWithin(itemId: string, ancestorId: string): Promise<boolean> { return this.within(itemId, ancestorId); }

  async getDownload(itemId: string, request: Request): Promise<DownloadResult> {
    const item = await this.client.downloadInfo(itemId);
    await this.assertInScope(itemId, item);
    if (item.kind !== 'drive#file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');
    return { kind: 'stream', response: await this.client.download(item, request) };
  }

  async createFolder(parentId: string, name: string): Promise<StorageItem> {
    await this.assertInScope(parentId);
    return mapFile(await this.client.createFolder(parentId, validName(name)), parentId);
  }

  upload(): Promise<StorageItem> {
    throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'PikPak upload is unavailable because a safe streaming upload ticket could not be established');
  }

  async rename(itemId: string, name: string): Promise<StorageItem> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be renamed');
    await this.assertInScope(itemId);
    return mapFile(await this.client.rename(itemId, validName(name)), null);
  }

  async move(itemId: string, destinationId: string): Promise<StorageItem> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be moved');
    await this.assertInScope(itemId);
    await this.assertInScope(destinationId);
    await this.client.move(itemId, destinationId);
    const item = await this.client.stat(itemId);
    return mapFile({ ...item, parent_id: destinationId === 'root' ? '' : destinationId }, destinationId);
  }

  copy(): Promise<StorageItem> { throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'PikPak copy is not enabled'); }

  async remove(itemId: string): Promise<void> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be deleted');
    await this.assertInScope(itemId);
    await this.client.remove(itemId, this.useTrash);
  }

  private async assertInScope(itemId: string, known?: PikPakFile): Promise<void> {
    if (!await this.within(itemId, this.rootId, known)) throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'PikPak item was not found');
  }

  private async within(itemId: string, ancestorId: string, known?: PikPakFile): Promise<boolean> {
    if (itemId === ancestorId) return true;
    let item: PikPakFile;
    try { item = known ?? await this.client.stat(itemId); }
    catch (error) { if (error instanceof HttpError && error.status === 404) return false; throw error; }
    if (ancestorId === 'root') return Boolean(item.id);
    const visited = new Set([item.id]);
    for (let depth = 0; depth < 256; depth += 1) {
      const parent = item.parent_id || 'root';
      if (parent === ancestorId) return true;
      if (parent === 'root' || visited.has(parent)) return false;
      visited.add(parent);
      try { item = await this.client.stat(parent); }
      catch (error) { if (error instanceof HttpError && error.status === 404) return false; throw error; }
    }
    return false;
  }
}
