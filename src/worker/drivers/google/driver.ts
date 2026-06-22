import { HttpError } from '../../http';
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
import { isGoogleNativeFile, mapGoogleFile } from './items';

export interface GoogleDriveDriverClient {
  list(parentId: string, cursor?: string): Promise<GoogleListResult>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  readonly capabilities = new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'delete'] as const);
  readonly rootId: string;
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

  private async assertInScope(itemId: string, knownItem?: GoogleFile): Promise<void> {
    if (await this.isWithinAncestor(itemId, this.rootId, knownItem)) return;
    throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Google Drive item was not found');
  }

  private async isWithinAncestor(itemId: string, ancestorId: string, knownItem?: GoogleFile): Promise<boolean> {
    let ancestor: GoogleFile;
    try {
      ancestor = itemId === ancestorId && knownItem ? knownItem : await this.client.stat(ancestorId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    const canonicalAncestorId = ancestor.id;
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
