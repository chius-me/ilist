import { HttpError } from '../../http';
import type { Mount } from '../../types';
import { S3Client, S3Error, type GetObjectOptions, type ListObjectsV2Options, type PutObjectOptions, type S3ListObjectsResult, type S3UploadPartOptions } from './client';
import { UPLOAD_PART_SIZE_BYTES, type CompletedUploadPart, type DownloadResult, type ListResult, type ResumableUploadAdapter, type StorageDriver, type StorageItem } from '../types';

export interface S3DriverClient {
  listObjectsV2(options?: ListObjectsV2Options): Promise<S3ListObjectsResult>;
  headObject(key: string): Promise<Response>;
  getObject(key: string, options?: GetObjectOptions): Promise<Response>;
  putObject(key: string, body: BodyInit | null, options?: PutObjectOptions): Promise<Response>;
  copyObject(sourceKey: string, destinationKey: string): Promise<Response>;
  deleteObject(key: string): Promise<Response>;
  createMultipartUpload(key: string, contentType: string | null, marker: string): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: BodyInit, options?: S3UploadPartOptions): Promise<{ etag: string }>;
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedUploadPart[]): Promise<{ etag: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<Response>;
}

type ItemKind = 'file' | 'folder';
interface ItemIdentity { v: 1; mount: string; key: string; kind: ItemKind }
interface S3MultipartUploadState {
  key: string;
  uploadId: string;
  parentId: string;
  contentType: string | null;
  marker: string;
  size: number;
}

const S3_RESUMABLE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, 'INVALID_ITEM_ID', 'Storage item ID is invalid');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    throw new HttpError(400, 'INVALID_ITEM_ID', 'Storage item ID is invalid');
  }
}

function normalizeRootPrefix(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value) || value.includes('\\')) {
    throw new HttpError(400, 'INVALID_MOUNT_CONFIG', 'S3 root prefix is invalid');
  }
  const normalized = value.replace(/^\/+|\/+$/g, '');
  return normalized ? `${normalized}/` : '';
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/') || normalized.includes('\\') || /[\u0000-\u001f]/.test(normalized)) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Storage item name is invalid');
  }
  return normalized;
}

function basename(key: string): string {
  const clean = key.endsWith('/') ? key.slice(0, -1) : key;
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function parentPrefix(key: string): string {
  const clean = key.endsWith('/') ? key.slice(0, -1) : key;
  const separator = clean.lastIndexOf('/');
  return separator === -1 ? '' : clean.slice(0, separator + 1);
}

function headerNumber(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function notFound(): HttpError {
  return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Storage item was not found');
}

function invalidUploadState(): HttpError {
  return new HttpError(400, 'INVALID_UPLOAD_STATE', 'S3 upload session state is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class S3Driver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'delete'] as const);
  readonly rootId: string;
  readonly resumableUpload: ResumableUploadAdapter = {
    create: async (input) => {
      const parent = this.requireFolder(input.parentId);
      const name = validateName(input.name);
      if (input.partSize !== UPLOAD_PART_SIZE_BYTES) {
        throw new HttpError(400, 'INVALID_UPLOAD_PART_SIZE', 'S3 multipart uploads require 10 MiB parts');
      }
      const contentType = this.requireContentType(input.contentType);
      const key = `${parent.key}${name}`;
      const marker = crypto.randomUUID();
      const { uploadId } = await this.client.createMultipartUpload(key, contentType, marker);
      return {
        state: { key, uploadId, parentId: input.parentId, contentType, marker, size: input.size },
        expiresAt: Date.now() + S3_RESUMABLE_UPLOAD_TTL_MS,
      };
    },
    uploadPart: async (input) => {
      const state = this.requireMultipartUploadState(input.state);
      const { etag } = await this.client.uploadPart(state.key, state.uploadId, input.partNumber, input.body, { signal: input.signal });
      return { part: { partNumber: input.partNumber, size: input.size, etag } };
    },
    complete: async (input) => {
      const state = this.requireMultipartUploadState(input.state);
      const parts = [...input.parts].sort((left, right) => left.partNumber - right.partNumber);
      try {
        const result = await this.client.completeMultipartUpload(state.key, state.uploadId, parts);
        return {
          ...this.toItem(state.key, 'file', state.parentId),
          size: state.size,
          contentType: state.contentType,
          etag: result.etag,
        };
      } catch (error) {
        if (!(error instanceof S3Error) || error.code !== 'NoSuchUpload') throw error;
        let response: Response;
        try {
          response = await this.client.headObject(state.key);
        } catch {
          throw error;
        }
        const marker = response.headers.get('x-amz-meta-ilist-upload-marker');
        if (marker !== state.marker || headerNumber(response, 'content-length') !== state.size) throw error;
        return {
          ...this.toItem(state.key, 'file', state.parentId),
          size: state.size,
          contentType: state.contentType,
          modifiedAt: response.headers.get('last-modified'),
          etag: response.headers.get('etag'),
        };
      }
    },
    abort: async (state) => {
      const uploadState = this.requireMultipartUploadState(state);
      try {
        await this.client.abortMultipartUpload(uploadState.key, uploadState.uploadId);
      } catch (error) {
        if (!(error instanceof S3Error) || error.code !== 'NoSuchUpload') throw error;
      }
    },
  };
  private readonly rootPrefix: string;

  constructor(private readonly mount: Mount, private readonly client: S3DriverClient) {
    this.rootPrefix = normalizeRootPrefix((mount.config as Record<string, unknown> | null)?.rootPrefix);
    this.rootId = this.itemId(this.rootPrefix, 'folder');
  }

  itemId(key: string, kind: ItemKind): string {
    this.assertScopedKey(key, kind);
    return base64UrlEncode(JSON.stringify({ v: 1, mount: this.mount.id, key, kind } satisfies ItemIdentity));
  }

  decodeItemId(id: string): ItemIdentity {
    let value: unknown;
    try { value = JSON.parse(base64UrlDecode(id)); } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'INVALID_ITEM_ID', 'Storage item ID is invalid');
    }
    if (!value || typeof value !== 'object') throw new HttpError(400, 'INVALID_ITEM_ID', 'Storage item ID is invalid');
    const identity = value as Partial<ItemIdentity>;
    if (identity.v !== 1 || identity.mount !== this.mount.id || typeof identity.key !== 'string' || (identity.kind !== 'file' && identity.kind !== 'folder')) {
      throw new HttpError(400, 'INVALID_ITEM_ID', 'Storage item ID is invalid');
    }
    this.assertScopedKey(identity.key, identity.kind);
    return identity as ItemIdentity;
  }

  async list(parentId: string, cursor?: string): Promise<ListResult> {
    const parent = this.requireFolder(parentId);
    const result = await this.client.listObjectsV2({ prefix: parent.key, delimiter: '/', ...(cursor ? { continuationToken: cursor } : {}) });
    const folders = result.commonPrefixes
      .filter((key) => key !== parent.key && key.startsWith(parent.key))
      .map((key) => this.toItem(key, 'folder', parentId));
    const files = result.objects
      .filter((object) => object.key !== parent.key && !object.key.endsWith('/') && object.key.startsWith(parent.key))
      .map((object) => ({
        ...this.toItem(object.key, 'file', parentId),
        size: object.size,
        modifiedAt: object.lastModified,
        etag: object.etag,
      }));
    return { items: [...folders, ...files], nextCursor: result.nextContinuationToken };
  }

  async stat(itemId: string): Promise<StorageItem> {
    const identity = this.decodeItemId(itemId);
    if (itemId === this.rootId) return this.toItem(identity.key, 'folder', null);
    if (identity.kind === 'folder') {
      const result = await this.client.listObjectsV2({ prefix: identity.key, maxKeys: 1 });
      if (!result.objects.length && !result.commonPrefixes.length) throw notFound();
      return this.toItem(identity.key, 'folder', this.parentId(identity.key));
    }
    try {
      const response = await this.client.headObject(identity.key);
      return {
        ...this.toItem(identity.key, 'file', this.parentId(identity.key)),
        size: headerNumber(response, 'content-length'),
        contentType: response.headers.get('content-type'),
        modifiedAt: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
      };
    } catch (error) {
      if (error instanceof S3Error && error.status === 404) throw notFound();
      throw error;
    }
  }

  async isWithin(itemId: string, ancestorId: string): Promise<boolean> {
    try {
      if (itemId === ancestorId) {
        this.decodeItemId(itemId);
        return true;
      }
      const item = this.decodeItemId(itemId);
      const ancestor = this.decodeItemId(ancestorId);
      return ancestor.kind === 'folder' && item.key.startsWith(ancestor.key);
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) return false;
      throw error;
    }
  }

  async getDownload(itemId: string, request: Request): Promise<DownloadResult> {
    const identity = this.decodeItemId(itemId);
    if (identity.kind !== 'file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');
    if (request.method === 'HEAD') {
      const upstream = await this.client.headObject(identity.key);
      return { kind: 'stream', response: new Response(null, { status: upstream.status, headers: upstream.headers }) };
    }
    const range = request.headers.get('range') ?? undefined;
    return { kind: 'stream', response: await this.client.getObject(identity.key, range ? { range } : {}) };
  }

  async createFolder(parentId: string, name: string): Promise<StorageItem> {
    const parent = this.requireFolder(parentId);
    const key = `${parent.key}${validateName(name)}/`;
    const marker = new ReadableStream({ start(controller) { controller.close(); } });
    const response = await this.client.putObject(key, marker, { contentType: 'application/x-directory' });
    return { ...this.toItem(key, 'folder', parentId), etag: response.headers.get('etag') };
  }

  async upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<StorageItem> {
    const parent = this.requireFolder(parentId);
    const key = `${parent.key}${validateName(name)}`;
    const response = await this.client.putObject(key, body, { ...(contentType ? { contentType } : {}) });
    return { ...this.toItem(key, 'file', parentId), contentType, etag: response.headers.get('etag') };
  }

  async rename(itemId: string, name: string): Promise<StorageItem> {
    const identity = this.decodeItemId(itemId);
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be renamed');
    const destination = `${parentPrefix(identity.key)}${validateName(name)}${identity.kind === 'folder' ? '/' : ''}`;
    await this.relocate(identity, destination);
    return this.toItem(destination, identity.kind, this.parentId(destination));
  }

  async move(itemId: string, destinationId: string): Promise<StorageItem> {
    const identity = this.decodeItemId(itemId);
    const destination = this.requireFolder(destinationId);
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be moved');
    if (identity.kind === 'folder' && destination.key.startsWith(identity.key)) {
      throw new HttpError(409, 'INVALID_STORAGE_DESTINATION', 'Folder cannot be moved inside itself');
    }
    const target = `${destination.key}${basename(identity.key)}${identity.kind === 'folder' ? '/' : ''}`;
    await this.relocate(identity, target);
    return this.toItem(target, identity.kind, destinationId);
  }

  async remove(itemId: string): Promise<void> {
    const identity = this.decodeItemId(itemId);
    if (itemId === this.rootId) throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Mount root cannot be deleted');
    if (identity.kind === 'file') { await this.client.deleteObject(identity.key); return; }
    const keys = await this.listAllKeys(identity.key);
    for (const key of keys.sort((left, right) => right.length - left.length)) await this.client.deleteObject(key);
  }

  private async relocate(identity: ItemIdentity, destination: string): Promise<void> {
    this.assertScopedKey(destination, identity.kind);
    if (destination === identity.key) {
      throw new HttpError(409, 'INVALID_STORAGE_DESTINATION', 'Source and destination are the same');
    }
    if (identity.kind === 'file') {
      await this.client.copyObject(identity.key, destination);
      await this.client.deleteObject(identity.key);
      return;
    }
    const sources = await this.listAllKeys(identity.key);
    for (const source of sources) await this.client.copyObject(source, `${destination}${source.slice(identity.key.length)}`);
    for (const source of sources.sort((left, right) => right.length - left.length)) await this.client.deleteObject(source);
  }

  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listObjectsV2({ prefix, ...(cursor ? { continuationToken: cursor } : {}) });
      keys.push(...result.objects.map((object) => object.key).filter((key) => key.startsWith(prefix)));
      cursor = result.nextContinuationToken ?? undefined;
    } while (cursor);
    return [...new Set(keys)];
  }

  private requireFolder(id: string): ItemIdentity {
    const identity = this.decodeItemId(id);
    if (identity.kind !== 'folder') throw new HttpError(400, 'INVALID_STORAGE_PARENT', 'Storage parent must be a folder');
    return identity;
  }

  private requireMultipartUploadState(state: Record<string, unknown>): S3MultipartUploadState {
    if (!isRecord(state)) throw invalidUploadState();
    const { key, uploadId, parentId, contentType, marker, size } = state;
    if (typeof key !== 'string' || typeof uploadId !== 'string' || typeof parentId !== 'string') throw invalidUploadState();
    if (!uploadId.trim() || /[\u0000-\u001f]/.test(uploadId)) throw invalidUploadState();
    if (typeof marker !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)) {
      throw invalidUploadState();
    }
    if (!Number.isSafeInteger(size) || (size as number) < 0) throw invalidUploadState();
    const normalizedContentType = this.requireContentType(contentType, true);

    let parent: ItemIdentity;
    try {
      parent = this.requireFolder(parentId);
    } catch {
      throw invalidUploadState();
    }
    if (!key.startsWith(parent.key)) throw invalidUploadState();
    const name = key.slice(parent.key.length);
    try {
      if (key !== `${parent.key}${validateName(name)}`) throw invalidUploadState();
    } catch {
      throw invalidUploadState();
    }
    return { key, uploadId, parentId, contentType: normalizedContentType, marker, size: size as number };
  }

  private requireContentType(value: unknown, fromState = false): string | null {
    if (value === null) return null;
    if (typeof value === 'string' && !/[\u0000-\u001f]/.test(value)) return value;
    if (fromState) throw invalidUploadState();
    throw new HttpError(400, 'INVALID_UPLOAD_CONTENT_TYPE', 'S3 upload content type is invalid');
  }

  private parentId(key: string): string | null {
    if (key === this.rootPrefix) return null;
    const parent = parentPrefix(key);
    return this.itemId(parent.length < this.rootPrefix.length ? this.rootPrefix : parent, 'folder');
  }

  private toItem(key: string, kind: ItemKind, parentId: string | null): StorageItem {
    return { id: this.itemId(key, kind), parentId, name: key === this.rootPrefix ? this.mount.name : basename(key), kind, size: kind === 'folder' ? null : 0, contentType: null, modifiedAt: null, etag: null };
  }

  private assertScopedKey(key: string, kind: ItemKind): void {
    if (!key.startsWith(this.rootPrefix) || (kind === 'folder' && key !== '' && !key.endsWith('/')) || (kind === 'file' && key.endsWith('/'))) {
      throw new HttpError(400, 'INVALID_ITEM_ID', 'Storage item is outside the mount root');
    }
  }
}

export function createS3Driver(mount: Mount, client: S3Client): S3Driver {
  return new S3Driver(mount, client);
}
