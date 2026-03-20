import { HttpError } from '../../http';
import type { Mount } from '../../types';
import { UPLOAD_PART_SIZE_BYTES, type DownloadResult, type ListResult, type ResumableUploadAdapter, type StorageDriver, type StorageItem } from '../types';
import type { GraphDriveItem, GraphItemUpdate, GraphListResult, GraphUploadPartResult, GraphUploadSession, UploadSessionRequestOptions } from './client';
import { graphItemKind, hasSupportedGraphItemType, mapGraphItem } from './mapper';

export interface OneDriveDriverClient {
  list(parentId: string, cursor?: string): Promise<GraphListResult>;
  stat(itemId: string): Promise<GraphDriveItem>;
  getDownloadUrl(itemId: string): Promise<string>;
  createFolder(parentId: string, name: string): Promise<GraphDriveItem>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<GraphDriveItem>;
  createUploadSession(parentId: string, name: string): Promise<GraphUploadSession>;
  uploadSessionPart(session: GraphUploadSession, body: ReadableStream, contentRange: string, contentLength: number, options?: UploadSessionRequestOptions): Promise<GraphUploadPartResult>;
  getUploadSessionStatus(session: GraphUploadSession): Promise<GraphUploadSession>;
  cancelUploadSession(session: GraphUploadSession): Promise<void>;
  update(itemId: string, update: GraphItemUpdate): Promise<GraphDriveItem>;
  remove(itemId: string): Promise<void>;
}

interface OneDriveUploadSessionState extends GraphUploadSession {
  parentId: string;
  name: string;
  contentType: string | null;
}

function validName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/') || normalized.includes('\\') || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Storage item name is invalid');
  }
  return normalized;
}

function invalidUploadState(): HttpError {
  return new HttpError(400, 'INVALID_UPLOAD_STATE', 'OneDrive upload session state is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OneDriveDriver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'delete'] as const);
  readonly rootId: string;
  readonly resumableUpload: ResumableUploadAdapter = {
    create: async (input) => {
      await this.assertInScope(input.parentId);
      const name = validName(input.name);
      if (input.partSize !== UPLOAD_PART_SIZE_BYTES) {
        throw new HttpError(400, 'INVALID_UPLOAD_PART_SIZE', 'OneDrive upload sessions require 10 MiB parts');
      }
      const contentType = this.requireContentType(input.contentType);
      const session = await this.client.createUploadSession(input.parentId, name);
      const expiresAt = Date.parse(session.expirationDateTime);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new HttpError(502, 'ONEDRIVE_UPLOAD_SESSION_INVALID', 'OneDrive upload session response was invalid');
      }
      return {
        state: {
          uploadUrl: session.uploadUrl,
          expirationDateTime: session.expirationDateTime,
          integrityProof: session.integrityProof,
          parentId: input.parentId,
          name,
          contentType,
        },
        expiresAt,
      };
    },
    uploadPart: async (input) => {
      const state = this.requireUploadSessionState(input.state);
      const contentRange = `bytes ${input.offset}-${input.offset + input.size - 1}/${input.totalSize}`;
      const result = await this.client.uploadSessionPart(this.toGraphUploadSession(state), input.body, contentRange, input.size, { signal: input.signal });
      if (!result.completed) {
        return {
          state: {
            ...state,
            uploadUrl: result.session.uploadUrl,
            expirationDateTime: result.session.expirationDateTime,
            integrityProof: result.session.integrityProof,
          },
          part: { partNumber: input.partNumber, size: input.size, etag: null },
        };
      }
      return {
        part: { partNumber: input.partNumber, size: input.size, etag: null },
        completedItem: mapGraphItem(result.item, state.parentId),
      };
    },
    complete: async (input) => {
      this.requireUploadSessionState(input.state);
      if (!input.completedItem) throw new HttpError(409, 'UPLOAD_INCOMPLETE', 'OneDrive upload session has not completed');
      return input.completedItem;
    },
    abort: async (state) => {
      const uploadState = this.requireUploadSessionState(state);
      await this.client.cancelUploadSession(this.toGraphUploadSession(uploadState));
    },
  };

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

  private requireUploadSessionState(state: Record<string, unknown>): OneDriveUploadSessionState {
    if (!isRecord(state)) throw invalidUploadState();
    const { uploadUrl, expirationDateTime, integrityProof, parentId, name, contentType } = state;
    if (typeof uploadUrl !== 'string' || typeof expirationDateTime !== 'string' || typeof integrityProof !== 'string' || !integrityProof || typeof parentId !== 'string' || !parentId) throw invalidUploadState();
    try {
      if (new URL(uploadUrl).protocol !== 'https:' || !Number.isFinite(Date.parse(expirationDateTime)) || Date.parse(expirationDateTime) <= Date.now()) {
        throw invalidUploadState();
      }
      return { uploadUrl, expirationDateTime, integrityProof, parentId, name: validName(name as string), contentType: this.requireContentType(contentType, true) };
    } catch {
      throw invalidUploadState();
    }
  }

  private requireContentType(value: unknown, fromState = false): string | null {
    if (value === null) return null;
    if (typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    if (fromState) throw invalidUploadState();
    throw new HttpError(400, 'INVALID_UPLOAD_CONTENT_TYPE', 'OneDrive upload content type is invalid');
  }

  private toGraphUploadSession(state: OneDriveUploadSessionState): GraphUploadSession {
    return { uploadUrl: state.uploadUrl, expirationDateTime: state.expirationDateTime, integrityProof: state.integrityProof };
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
