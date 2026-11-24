import { HttpError } from '../../http';
import { isRecord } from '../../shared/encoding';
import { headMetadataResponse } from '../../shared/http-client';
import type { Mount } from '../../types';
import { UPLOAD_PART_SIZE_BYTES, type DownloadResult, type ListResult, type ResumableUploadAdapter, type StorageDriver, type StorageItem } from '../types';
import type { GraphDriveItem, GraphItemUpdate, GraphListResult, GraphUploadPartResult, GraphUploadSession, UploadSessionRequestOptions } from './client';
import { graphItemKind, hasSupportedGraphItemType, mapGraphItem } from './mapper';

export interface OneDriveDriverClient {
  list(parentId: string, cursor?: string, limit?: number): Promise<GraphListResult>;
  stat(itemId: string): Promise<GraphDriveItem>;
  statByPath?(rootId: string, segments: string[]): Promise<GraphDriveItem>;
  getDownloadUrl(itemId: string): Promise<string>;
  download?(itemId: string, range?: string | null): Promise<Response>;
  createFolder(parentId: string, name: string): Promise<GraphDriveItem>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<GraphDriveItem>;
  copy?(itemId: string, destinationParentId: string, name: string): Promise<GraphDriveItem>;
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

export class OneDriveDriver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'copy', 'delete'] as const);
  readonly rootId: string;
  private canonicalRootId: string | null = null;
  private readonly verifiedInScope = new Set<string>();

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
      const state = this.requireLiveUploadSessionState(input.state);
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
      const uploadState = this.requireLiveUploadSessionState(state);
      await this.client.cancelUploadSession(this.toGraphUploadSession(uploadState));
    },
  };

  constructor(mount: Mount, private readonly client: OneDriveDriverClient) {
    this.rootId = mount.rootItemId ?? 'root';
  }

  async list(parentId: string, cursor?: string, limit?: number): Promise<ListResult> {
    await this.assertInScope(parentId);
    const result = limit === undefined
      ? await this.client.list(parentId, cursor)
      : await this.client.list(parentId, cursor, limit);
    const items = result.items.filter(hasSupportedGraphItemType).map((item) => {
      if (graphItemKind(item) === 'folder') this.verifiedInScope.add(item.id);
      return mapGraphItem(item, parentId);
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
    const rootItem = mapGraphItem(rootRaw, null);
    if (segments.length === 0) return [rootItem];

    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..' || /[/\\:\u0000-\u001f\u007f]/.test(segment)) {
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }
    }

    if (this.client.statByPath) {
      const resolvedRaw = await Promise.all(
        segments.map(async (_segment, index) => {
          try {
            return await this.client.statByPath!(this.rootId, segments.slice(0, index + 1));
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
              throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
            }
            throw error;
          }
        }),
      );
      const chain: StorageItem[] = [rootItem];
      let parentId = rootItem.id;
      for (let index = 0; index < resolvedRaw.length; index += 1) {
        const raw = resolvedRaw[index]!;
        if (!hasSupportedGraphItemType(raw)) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
        if (index < resolvedRaw.length - 1 && graphItemKind(raw) !== 'folder') {
          throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
        }
        await this.assertInScope(raw.id, raw);
        this.verifiedInScope.add(raw.id);
        const mapped = mapGraphItem(raw, parentId);
        chain.push(mapped);
        parentId = mapped.id;
      }
      return chain;
    }

    const chain: StorageItem[] = [rootItem];
    let current = rootItem;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const folderOnly = index < segments.length - 1;
      const items = await this.listAll(current.id);
      const child = items.find((entry) => entry.name === segment && (!folderOnly || entry.kind === 'folder'));
      if (!child) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      chain.push(child);
      current = child;
    }
    return chain;
  }

  async stat(itemId: string): Promise<StorageItem> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    return mapGraphItem(item, null);
  }

  async isWithin(itemId: string, ancestorId: string): Promise<boolean> {
    return this.isWithinAncestor(itemId, ancestorId);
  }

  async getDownload(itemId: string, request: Request): Promise<DownloadResult> {
    const item = await this.client.stat(itemId);
    await this.assertInScope(itemId, item);
    const mapped = mapGraphItem(item, null);
    if (mapped.kind !== 'file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');
    if (request.method.toUpperCase() === 'HEAD') {
      return { kind: 'stream', response: headMetadataResponse(mapped) };
    }
    if (this.client.download) {
      return { kind: 'stream', response: await this.client.download(itemId, request.headers.get('range')) };
    }
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
    this.verifiedInScope.delete(itemId);
    return mapGraphItem(await this.client.update(itemId, { parentReference: { id: destinationId } }), destinationId);
  }

  async copy(itemId: string, destinationParentId: string): Promise<StorageItem> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be copied');
    await this.assertInScope(itemId);
    await this.assertInScope(destinationParentId);
    const source = await this.client.stat(itemId);
    if (graphItemKind(source) === 'folder') {
      throw new HttpError(405, 'OPERATION_UNSUPPORTED', 'OneDrive folder copy is not supported');
    }
    if (this.client.copy) {
      return mapGraphItem(await this.client.copy(itemId, destinationParentId, source.name), destinationParentId);
    }
    const downloadUrl = await this.client.getDownloadUrl(itemId);
    const response = await fetch(downloadUrl);
    if (!response.ok || !response.body) {
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
    }
    return mapGraphItem(
      await this.client.upload(
        destinationParentId,
        source.name,
        response.body,
        source.file?.mimeType ?? null,
      ),
      destinationParentId,
    );
  }

  async remove(itemId: string): Promise<void> {
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be deleted');
    await this.assertInScope(itemId);
    this.verifiedInScope.delete(itemId);
    await this.client.remove(itemId);
  }

  private async listAll(parentId: string): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.list(parentId, cursor);
      items.push(...result.items);
      if (!result.nextCursor) return items;
      cursor = result.nextCursor;
    }
    throw new HttpError(502, 'PROVIDER_PAGINATION_LIMIT', 'Storage provider returned too many pages');
  }

  private requireUploadSessionState(state: Record<string, unknown>): OneDriveUploadSessionState {
    if (!isRecord(state)) throw invalidUploadState();
    const { uploadUrl, expirationDateTime, integrityProof, parentId, name, contentType } = state;
    if (typeof uploadUrl !== 'string' || typeof expirationDateTime !== 'string' || typeof integrityProof !== 'string' || !integrityProof || typeof parentId !== 'string' || !parentId) throw invalidUploadState();
    try {
      if (new URL(uploadUrl).protocol !== 'https:' || !Number.isFinite(Date.parse(expirationDateTime))) {
        throw invalidUploadState();
      }
      return { uploadUrl, expirationDateTime, integrityProof, parentId, name: validName(name as string), contentType: this.requireContentType(contentType, true) };
    } catch {
      throw invalidUploadState();
    }
  }

  private requireLiveUploadSessionState(state: Record<string, unknown>): OneDriveUploadSessionState {
    const uploadState = this.requireUploadSessionState(state);
    if (Date.parse(uploadState.expirationDateTime) <= Date.now()) throw invalidUploadState();
    return uploadState;
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

  private async resolveCanonicalRootId(knownItem?: GraphDriveItem): Promise<string> {
    if (this.canonicalRootId) return this.canonicalRootId;
    const ancestor = this.rootId && knownItem && this.rootId === knownItem.id
      ? knownItem
      : await this.client.stat(this.rootId);
    this.canonicalRootId = ancestor.id;
    return ancestor.id;
  }

  private async assertInScope(itemId: string, knownItem?: GraphDriveItem): Promise<void> {
    if (this.verifiedInScope.has(itemId)) return;
    if (await this.isWithinAncestor(itemId, this.rootId, knownItem)) {
      this.verifiedInScope.add(itemId);
      return;
    }
    throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'OneDrive item was not found');
  }

  private async isWithinAncestor(itemId: string, ancestorId: string, knownItem?: GraphDriveItem): Promise<boolean> {
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

    let item: GraphDriveItem;
    try {
      item = knownItem ?? await this.client.stat(itemId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    if (item.id === canonicalAncestorId) return true;
    const visited = new Set([item.id]);
    for (let depth = 0; depth < 256; depth += 1) {
      const parentId = item.parentReference?.id;
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
