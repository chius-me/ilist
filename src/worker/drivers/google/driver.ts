import { HttpError } from '../../http';
import { isRecord } from '../../shared/encoding';
import { headMetadataResponse } from '../../shared/http-client';
import type { Mount } from '../../types';
import {
  UPLOAD_PART_SIZE_BYTES,
  type DownloadResult,
  type ListResult,
  type ResumableUploadAdapter,
  type StorageDriver,
  type StorageItem,
} from '../types';
import type { GoogleFile, GoogleListResult, GoogleUploadPartResult, GoogleUploadSession } from './client';
import { GoogleDriveClient } from './client';
import { GOOGLE_FOLDER_MIME_TYPE, isGoogleNativeFile, mapGoogleFile } from './items';

export interface GoogleDriveDriverClient {
  list(parentId: string, cursor?: string, limit?: number): Promise<GoogleListResult>;
  findChildByName?(parentId: string, name: string, folderOnly?: boolean): Promise<GoogleFile | null>;
  existsByName?(parentId: string, name: string): Promise<boolean>;
  stat(itemId: string): Promise<GoogleFile>;
  download(itemId: string, range?: string | null): Promise<Response>;
  exportFile(itemId: string, contentType: string): Promise<Response>;
  createFolder(parentId: string, name: string): Promise<GoogleFile>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<GoogleFile>;
  createResumableUpload(parentId: string, name: string, size: number, contentType: string | null): Promise<GoogleUploadSession>;
  uploadResumablePart(
    sessionUrl: string,
    body: ReadableStream,
    contentRange: string,
    contentLength: number,
    options?: { signal?: AbortSignal },
  ): Promise<GoogleUploadPartResult>;
  abortResumableUpload(sessionUrl: string): Promise<void>;
  rename(itemId: string, name: string): Promise<GoogleFile>;
  copy(itemId: string, destinationParentId: string, name: string): Promise<GoogleFile>;
  move(itemId: string, destinationId: string): Promise<GoogleFile>;
  trash(itemId: string): Promise<GoogleFile>;
}

interface GoogleUploadState {
  sessionUrl: string;
  expiresAt: number;
  nextOffset: number;
  parentId: string;
  name: string;
  contentType: string | null;
}

function invalidUploadState(): HttpError {
  return new HttpError(400, 'INVALID_UPLOAD_STATE', 'Google upload session state is invalid');
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
  readonly capabilities = new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'copy', 'delete'] as const);
  readonly rootId: string;
  private canonicalRootId: string | null = null;
  private readonly verifiedInScope = new Set<string>();

  readonly resumableUpload: ResumableUploadAdapter = {
    create: async (input) => {
      await this.assertInScope(input.parentId);
      if (input.partSize !== UPLOAD_PART_SIZE_BYTES) {
        throw new HttpError(400, 'INVALID_UPLOAD_PART_SIZE', 'Google upload sessions require 10 MiB parts');
      }
      const name = validName(input.name);
      const contentType = this.validContentType(input.contentType);
      const session = await this.client.createResumableUpload(input.parentId, name, input.size, contentType);
      if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) {
        throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
      }
      return {
        state: {
          sessionUrl: session.sessionUrl,
          expiresAt: session.expiresAt,
          nextOffset: 0,
          parentId: input.parentId,
          name,
          contentType,
        },
        expiresAt: session.expiresAt,
      };
    },
    uploadPart: async (input) => {
      const state = this.requireLiveUploadState(input.state);
      if (state.nextOffset !== input.offset) {
        throw new HttpError(409, 'GOOGLE_UPLOAD_SESSION_INVALID_RANGE', 'Google upload part range is invalid');
      }
      const result = await this.client.uploadResumablePart(
        state.sessionUrl,
        input.body,
        `bytes ${input.offset}-${input.offset + input.size - 1}/${input.totalSize}`,
        input.size,
        { signal: input.signal },
      );
      if (!result.completed) {
        return {
          state: { ...state, nextOffset: result.nextOffset },
          part: { partNumber: input.partNumber, size: input.size, etag: null },
        };
      }
      return {
        part: { partNumber: input.partNumber, size: input.size, etag: null },
        completedItem: { ...mapGoogleFile(result.item, state.parentId), parentId: state.parentId },
      };
    },
    complete: async (input) => {
      this.requireUploadState(input.state);
      if (!input.completedItem) throw new HttpError(409, 'UPLOAD_INCOMPLETE', 'Google upload session has not completed');
      return input.completedItem;
    },
    abort: async (state) => {
      await this.client.abortResumableUpload(this.requireLiveUploadState(state).sessionUrl);
    },
  };

  constructor(mount: Mount, private readonly client: GoogleDriveDriverClient) {
    this.rootId = mount.rootItemId ?? 'root';
  }

  async list(parentId: string, cursor?: string, limit?: number): Promise<ListResult> {
    await this.assertInScope(parentId);
    const result = limit === undefined
      ? await this.client.list(parentId, cursor)
      : await this.client.list(parentId, cursor, limit);
    const items = result.items
      .filter((item) => !item.trashed)
      .map((item) => {
        if (item.mimeType === GOOGLE_FOLDER_MIME_TYPE) this.verifiedInScope.add(item.id);
        return { ...mapGoogleFile(item, parentId), parentId };
      });
    return {
      items,
      nextCursor: result.nextCursor,
    };
  }

  async resolvePath(segments: string[]): Promise<StorageItem[]> {
    const rootRaw = await this.client.stat(this.rootId);
    this.canonicalRootId = rootRaw.id;
    this.verifiedInScope.add(this.rootId);
    this.verifiedInScope.add(rootRaw.id);
    const rootItem = { ...mapGoogleFile(rootRaw, null), id: this.rootId, parentId: null };
    const chain: StorageItem[] = [rootItem];
    let current: StorageItem = rootItem;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (!segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment)) {
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }
      const isLast = index === segments.length - 1;
      let found: GoogleFile | null = null;
      if (this.client.findChildByName) {
        found = await this.client.findChildByName(current.id, segment, true);
        if (!found && isLast) {
          found = await this.client.findChildByName(current.id, segment, false);
        }
      } else {
        const listed = (await this.client.list(current.id)).items;
        found = listed.find(
          (entry) => !entry.trashed && entry.name === segment && entry.mimeType === GOOGLE_FOLDER_MIME_TYPE,
        ) ?? (isLast ? listed.find((entry) => !entry.trashed && entry.name === segment) ?? null : null);
      }
      if (!found || found.trashed) {
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }
      if (!isLast && found.mimeType !== GOOGLE_FOLDER_MIME_TYPE) {
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }
      this.verifiedInScope.add(found.id);
      const mapped = { ...mapGoogleFile(found, current.id), parentId: current.id };
      chain.push(mapped);
      current = mapped;
    }

    return chain;
  }

  async stat(itemId: string): Promise<StorageItem> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    const mapped = mapGoogleFile(item, null);
    return itemId === this.rootId ? { ...mapped, id: this.rootId, parentId: null } : mapped;
  }

  async isWithin(itemId: string, ancestorId: string): Promise<boolean> {
    return this.isWithinAncestor(itemId, ancestorId);
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
    if (request.method.toUpperCase() === 'HEAD') {
      return { kind: 'stream', response: headMetadataResponse(mapped) };
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
    this.verifiedInScope.delete(itemId);
    return { ...mapGoogleFile(await this.client.move(itemId, destinationId), destinationId), parentId: destinationId };
  }

  async copy(itemId: string, destinationParentId: string): Promise<StorageItem> {
    this.assertMutable(itemId, 'copied');
    await this.assertInScope(itemId);
    await this.assertInScope(destinationParentId);
    const source = await this.client.stat(itemId);
    if (source.mimeType === GOOGLE_FOLDER_MIME_TYPE || source.mimeType?.startsWith('application/vnd.google-apps.')) {
      throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'Google Drive folder or Workspace copy is not supported');
    }
    const conflict = this.client.existsByName
      ? await this.client.existsByName(destinationParentId, source.name)
      : Boolean((await this.listAll(destinationParentId)).find((item) => item.name === source.name));
    if (conflict) throw new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name');
    return {
      ...mapGoogleFile(await this.client.copy(itemId, destinationParentId, source.name), destinationParentId),
      parentId: destinationParentId,
    };
  }

  async remove(itemId: string): Promise<void> {
    this.assertMutable(itemId, 'deleted');
    await this.assertInScope(itemId);
    this.verifiedInScope.delete(itemId);
    await this.client.trash(itemId);
  }

  private async listAll(parentId: string): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.list(parentId, cursor);
      for (const item of result.items) {
        if (!item.trashed) items.push({ ...mapGoogleFile(item, parentId), parentId });
      }
      if (!result.nextCursor) return items;
      cursor = result.nextCursor;
    }
    throw new HttpError(502, 'PROVIDER_PAGINATION_LIMIT', 'Storage provider returned too many pages');
  }

  private assertMutable(itemId: string, operation: string): void {
    if (itemId === this.rootId) {
      throw new HttpError(400, 'INVALID_STORAGE_OPERATION', `Mount root cannot be ${operation}`);
    }
  }

  private validContentType(value: unknown, fromState = false): string | null {
    if (value === null) return null;
    if (typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    if (fromState) throw invalidUploadState();
    throw new HttpError(400, 'INVALID_UPLOAD_CONTENT_TYPE', 'Google upload content type is invalid');
  }

  private requireUploadState(state: Record<string, unknown>): GoogleUploadState {
    if (!isRecord(state)) throw invalidUploadState();
    const { sessionUrl, expiresAt, nextOffset, parentId, name, contentType } = state;
    if (
      typeof sessionUrl !== 'string'
      || typeof expiresAt !== 'number'
      || !Number.isSafeInteger(expiresAt)
      || typeof nextOffset !== 'number'
      || !Number.isSafeInteger(nextOffset)
      || nextOffset < 0
      || typeof parentId !== 'string'
      || !parentId
      || typeof name !== 'string'
    ) throw invalidUploadState();
    try {
      if (new URL(sessionUrl).protocol !== 'https:') throw invalidUploadState();
      return {
        sessionUrl,
        expiresAt,
        nextOffset,
        parentId,
        name: validName(name),
        contentType: this.validContentType(contentType, true),
      };
    } catch {
      throw invalidUploadState();
    }
  }

  private requireLiveUploadState(state: Record<string, unknown>): GoogleUploadState {
    const uploadState = this.requireUploadState(state);
    if (uploadState.expiresAt <= Date.now()) throw invalidUploadState();
    return uploadState;
  }

  private async resolveCanonicalRootId(knownItem?: GoogleFile): Promise<string> {
    if (this.canonicalRootId) return this.canonicalRootId;
    const ancestor = this.rootId && knownItem && this.rootId === knownItem.id
      ? knownItem
      : await this.client.stat(this.rootId);
    this.canonicalRootId = ancestor.id;
    return ancestor.id;
  }

  private async assertInScope(itemId: string, knownItem?: GoogleFile): Promise<void> {
    if (this.verifiedInScope.has(itemId)) return;
    if (await this.isWithinAncestor(itemId, this.rootId, knownItem)) {
      this.verifiedInScope.add(itemId);
      return;
    }
    throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Google Drive item was not found');
  }

  private async isWithinAncestor(itemId: string, ancestorId: string, knownItem?: GoogleFile): Promise<boolean> {
    let canonicalAncestorId: string;
    try {
      if (ancestorId === this.rootId) {
        canonicalAncestorId = await this.resolveCanonicalRootId(itemId === ancestorId ? knownItem : undefined);
      } else {
        const ancestor = itemId === ancestorId && knownItem ? knownItem : await this.client.stat(ancestorId);
        canonicalAncestorId = ancestor.id;
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    if (itemId === ancestorId || knownItem?.id === canonicalAncestorId) return true;

    let item: GoogleFile;
    try {
      item = knownItem ?? await this.client.stat(itemId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    if (item.id === canonicalAncestorId) return true;
    const visited = new Set([item.id]);
    for (let depth = 0; depth < 256; depth += 1) {
      const parentId = item.parents?.[0];
      if (parentId === canonicalAncestorId) return true;
      if (ancestorId === this.rootId && parentId && this.verifiedInScope.has(parentId)) return true;
      if (!parentId || visited.has(parentId)) return false;
      visited.add(parentId);
      try {
        item = await this.client.stat(parentId);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return false;
        throw error;
      }
      if (item.id === canonicalAncestorId) return true;
    }
    return false;
  }
}

export function createGoogleDriveDriver(env: import('../../types').Env, mount: Mount): GoogleDriveDriver {
  return new GoogleDriveDriver(mount, new GoogleDriveClient(env, mount.id));
}
