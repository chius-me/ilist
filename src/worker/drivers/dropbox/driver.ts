import { HttpError } from '../../http';
import type { FileExportOption, Mount } from '../../types';
import {
  UPLOAD_PART_SIZE_BYTES,
  type DownloadResult,
  type ListResult,
  type ResumableUploadAdapter,
  type StorageDriver,
  type StorageItem,
} from '../types';
import { DropboxClient } from './client';
import type { DropboxMetadata } from './types';

export const DROPBOX_ROOT_ID = 'dropbox-root';
const UPLOAD_SESSION_TTL_MS = 6 * 24 * 60 * 60_000;

export interface DropboxDriverClient {
  list(path: string, cursor?: string): Promise<{ items: DropboxMetadata[]; nextCursor: string | null }>;
  stat(path: string): Promise<DropboxMetadata>;
  download(path: string, range?: string | null): Promise<Response>;
  exportFile(path: string, format: string): Promise<Response>;
  createFolder(path: string): Promise<DropboxMetadata>;
  upload(path: string, body: ReadableStream): Promise<DropboxMetadata>;
  move(fromPath: string, toPath: string): Promise<DropboxMetadata>;
  copy(fromPath: string, toPath: string): Promise<DropboxMetadata>;
  remove(path: string): Promise<void>;
  createUploadSession(): Promise<string>;
  appendUploadSession(
    sessionId: string,
    offset: number,
    body: ReadableStream | Uint8Array,
    close: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  finishUploadSession(sessionId: string, offset: number, path: string): Promise<DropboxMetadata>;
  closeUploadSession(sessionId: string, offset: number): Promise<void>;
}

interface DropboxUploadState {
  sessionId: string;
  nextOffset: number;
  parentId: string;
  name: string;
  expiresAt: number;
}

const EXPORT_TYPES: Record<string, { extension: string; contentType: string }> = {
  docx: { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  html: { extension: 'html', contentType: 'text/html' },
  jpeg: { extension: 'jpg', contentType: 'image/jpeg' },
  jpg: { extension: 'jpg', contentType: 'image/jpeg' },
  markdown: { extension: 'md', contentType: 'text/markdown' },
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
  png: { extension: 'png', contentType: 'image/png' },
  txt: { extension: 'txt', contentType: 'text/plain' },
};

const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
  xml: 'application/xml',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function contentType(name: string): string | null {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  return extension ? CONTENT_TYPES[extension] ?? null : null;
}

function exportOptions(metadata: DropboxMetadata): FileExportOption[] | undefined {
  const values = [metadata.export_info?.export_as, ...(metadata.export_info?.export_options ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const unique = [...new Set(values)];
  if (!unique.length) return undefined;
  return unique.map((format) => {
    const normalized = format.toLowerCase();
    const known = EXPORT_TYPES[normalized] ?? { extension: normalized, contentType: 'application/octet-stream' };
    return { format, label: format.toUpperCase(), ...known };
  });
}

function mapDropboxMetadata(metadata: DropboxMetadata, parentId: string | null): StorageItem {
  const folder = metadata['.tag'] === 'folder';
  return {
    id: metadata.id,
    parentId,
    name: metadata.name,
    kind: folder ? 'folder' : 'file',
    size: folder ? null : typeof metadata.size === 'number' ? metadata.size : null,
    contentType: folder ? null : contentType(metadata.name),
    modifiedAt: folder ? null : metadata.server_modified ?? metadata.client_modified ?? null,
    etag: metadata.rev ?? metadata.content_hash ?? null,
    ...(folder ? {} : { exportOptions: exportOptions(metadata) }),
  };
}

function invalidUploadState(): HttpError {
  return new HttpError(400, 'INVALID_UPLOAD_STATE', 'Dropbox upload session state is invalid');
}

function pathOf(metadata: DropboxMetadata): string {
  if (typeof metadata.path_display !== 'string') {
    throw new HttpError(502, 'DROPBOX_UPSTREAM_INVALID', 'Dropbox response was invalid');
  }
  return metadata.path_display;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : `/${name}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
}

export class DropboxDriver implements StorageDriver {
  readonly capabilities = new Set(['list', 'download', 'upload', 'multipartUpload', 'createFolder', 'rename', 'move', 'copy', 'delete'] as const);
  readonly rootId: string;
  readonly resumableUpload: ResumableUploadAdapter = {
    create: async (input) => {
      await this.assertInScope(input.parentId);
      if (input.partSize !== UPLOAD_PART_SIZE_BYTES) {
        throw new HttpError(400, 'INVALID_UPLOAD_PART_SIZE', 'Dropbox upload sessions require 10 MiB parts');
      }
      const name = validName(input.name);
      const sessionId = await this.client.createUploadSession();
      const expiresAt = Date.now() + UPLOAD_SESSION_TTL_MS;
      return {
        state: { sessionId, nextOffset: 0, parentId: input.parentId, name, expiresAt },
        expiresAt,
      };
    },
    uploadPart: async (input) => {
      const state = this.requireLiveUploadState(input.state);
      if (state.nextOffset !== input.offset) {
        throw new HttpError(409, 'DROPBOX_UPLOAD_SESSION_INVALID_RANGE', 'Dropbox upload part range is invalid');
      }
      await this.client.appendUploadSession(state.sessionId, input.offset, input.body, false, input.signal);
      return {
        state: { ...state, nextOffset: input.offset + input.size },
        part: { partNumber: input.partNumber, size: input.size, etag: null },
      };
    },
    complete: async (input) => {
      const state = this.requireLiveUploadState(input.state);
      const parent = await this.requireFolderMetadata(state.parentId);
      const metadata = await this.client.finishUploadSession(
        state.sessionId,
        state.nextOffset,
        joinPath(this.directoryPath(state.parentId, parent), state.name),
      );
      return mapDropboxMetadata(metadata, state.parentId);
    },
    abort: async (state) => {
      const upload = this.requireUploadState(state);
      try {
        await this.client.closeUploadSession(upload.sessionId, upload.nextOffset);
      } catch {
        // Dropbox has no delete-session endpoint. Session closure is best effort;
        // an unclosed provider session expires without committing a file.
      }
    },
  };

  constructor(private readonly mount: Mount, private readonly client: DropboxDriverClient) {
    this.rootId = mount.rootItemId ?? DROPBOX_ROOT_ID;
  }

  async list(parentId: string, cursor?: string): Promise<ListResult> {
    const parent = await this.requireFolderMetadata(parentId);
    const result = await this.client.list(this.directoryReference(parentId, parent), cursor);
    return {
      items: result.items.map((item) => mapDropboxMetadata(item, parentId)),
      nextCursor: result.nextCursor,
    };
  }

  async stat(itemId: string): Promise<StorageItem> {
    if (itemId === DROPBOX_ROOT_ID && this.rootId === DROPBOX_ROOT_ID) return this.syntheticRoot();
    const metadata = await this.client.stat(itemId);
    await this.assertInScope(itemId, metadata);
    if (itemId === this.rootId) return { ...mapDropboxMetadata(metadata, null), id: this.rootId, parentId: null };
    return mapDropboxMetadata(metadata, await this.parentId(metadata));
  }

  async isWithin(itemId: string, ancestorId: string): Promise<boolean> {
    if (itemId === ancestorId) return true;
    let item: DropboxMetadata;
    try {
      item = await this.client.stat(itemId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    if (ancestorId === DROPBOX_ROOT_ID && this.rootId === DROPBOX_ROOT_ID) return true;
    let ancestor: DropboxMetadata;
    try {
      ancestor = await this.client.stat(ancestorId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    const itemPath = item.path_lower;
    const ancestorPath = ancestor.path_lower;
    return typeof itemPath === 'string'
      && typeof ancestorPath === 'string'
      && (itemPath === ancestorPath || itemPath.startsWith(`${ancestorPath}/`));
  }

  async getDownload(itemId: string, request: Request): Promise<DownloadResult> {
    const metadata = await this.client.stat(itemId);
    await this.assertInScope(itemId, metadata);
    if (metadata['.tag'] !== 'file') throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Folders cannot be downloaded');
    const options = exportOptions(metadata);
    const requestedFormat = new URL(request.url).searchParams.get('export');
    if (requestedFormat) {
      if (!options?.some((option) => option.format === requestedFormat)) {
        throw new HttpError(400, 'DROPBOX_EXPORT_UNSUPPORTED', 'Dropbox export format is unsupported');
      }
      return { kind: 'stream', response: await this.client.exportFile(itemId, requestedFormat) };
    }
    if (metadata.is_downloadable === false && options?.length) {
      throw new HttpError(400, 'DROPBOX_EXPORT_REQUIRED', 'A Dropbox export format is required');
    }
    return { kind: 'stream', response: await this.client.download(itemId, request.headers.get('range')) };
  }

  async createFolder(parentId: string, name: string): Promise<StorageItem> {
    const parent = await this.requireFolderMetadata(parentId);
    const created = await this.client.createFolder(joinPath(this.directoryPath(parentId, parent), validName(name)));
    return mapDropboxMetadata(created, parentId);
  }

  async upload(parentId: string, name: string, body: ReadableStream, _contentType: string | null): Promise<StorageItem> {
    const parent = await this.requireFolderMetadata(parentId);
    const uploaded = await this.client.upload(joinPath(this.directoryPath(parentId, parent), validName(name)), body);
    return mapDropboxMetadata(uploaded, parentId);
  }

  async rename(itemId: string, name: string): Promise<StorageItem> {
    this.assertMutable(itemId, 'renamed');
    const source = await this.requireMetadata(itemId);
    const sourcePath = pathOf(source);
    const parentId = await this.parentId(source);
    const moved = await this.client.move(itemId, joinPath(parentPath(sourcePath), validName(name)));
    return mapDropboxMetadata(moved, parentId);
  }

  async move(itemId: string, destinationId: string): Promise<StorageItem> {
    this.assertMutable(itemId, 'moved');
    const source = await this.requireMetadata(itemId);
    const destination = await this.requireFolderMetadata(destinationId);
    const moved = await this.client.move(itemId, joinPath(this.directoryPath(destinationId, destination), source.name));
    return mapDropboxMetadata(moved, destinationId);
  }

  async copy(itemId: string, destinationParentId: string): Promise<StorageItem> {
    this.assertMutable(itemId, 'copied');
    const source = await this.requireMetadata(itemId);
    const destination = await this.requireFolderMetadata(destinationParentId);
    const copied = await this.client.copy(itemId, joinPath(this.directoryPath(destinationParentId, destination), source.name));
    return mapDropboxMetadata(copied, destinationParentId);
  }

  async remove(itemId: string): Promise<void> {
    this.assertMutable(itemId, 'deleted');
    await this.requireMetadata(itemId);
    await this.client.remove(itemId);
  }

  private syntheticRoot(): StorageItem {
    return {
      id: this.rootId,
      parentId: null,
      name: this.mount.name,
      kind: 'folder',
      size: null,
      contentType: null,
      modifiedAt: null,
      etag: null,
    };
  }

  private directoryReference(itemId: string, metadata: DropboxMetadata): string {
    return itemId === DROPBOX_ROOT_ID && this.rootId === DROPBOX_ROOT_ID ? '' : itemId || pathOf(metadata);
  }

  private directoryPath(itemId: string, metadata: DropboxMetadata): string {
    return itemId === DROPBOX_ROOT_ID && this.rootId === DROPBOX_ROOT_ID ? '' : pathOf(metadata);
  }

  private async requireMetadata(itemId: string): Promise<DropboxMetadata> {
    if (itemId === DROPBOX_ROOT_ID && this.rootId === DROPBOX_ROOT_ID) {
      throw new HttpError(400, 'INVALID_STORAGE_OPERATION', 'Dropbox root metadata is synthetic');
    }
    const metadata = await this.client.stat(itemId);
    await this.assertInScope(itemId, metadata);
    return metadata;
  }

  private async requireFolderMetadata(itemId: string): Promise<DropboxMetadata> {
    if (itemId === DROPBOX_ROOT_ID && this.rootId === DROPBOX_ROOT_ID) {
      return { '.tag': 'folder', id: DROPBOX_ROOT_ID, name: this.mount.name, path_display: '', path_lower: '' };
    }
    const metadata = await this.requireMetadata(itemId);
    if (metadata['.tag'] !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'Entry is not a folder');
    return metadata;
  }

  private async parentId(metadata: DropboxMetadata): Promise<string | null> {
    const path = pathOf(metadata);
    const parent = parentPath(path);
    if (this.rootId === DROPBOX_ROOT_ID && parent === '') return this.rootId;
    if (this.rootId !== DROPBOX_ROOT_ID) {
      const root = await this.client.stat(this.rootId);
      if (root.path_lower === parent.toLowerCase()) return this.rootId;
    }
    if (!parent) return this.rootId;
    return (await this.client.stat(parent)).id;
  }

  private async assertInScope(itemId: string, known?: DropboxMetadata): Promise<void> {
    if (itemId === this.rootId) return;
    if (this.rootId === DROPBOX_ROOT_ID) return;
    const item = known ?? await this.client.stat(itemId);
    const root = await this.client.stat(this.rootId);
    if (
      typeof item.path_lower === 'string'
      && typeof root.path_lower === 'string'
      && (item.path_lower === root.path_lower || item.path_lower.startsWith(`${root.path_lower}/`))
    ) return;
    throw new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Dropbox item was not found');
  }

  private assertMutable(itemId: string, operation: string): void {
    if (itemId === this.rootId) {
      throw new HttpError(400, 'INVALID_STORAGE_OPERATION', `Mount root cannot be ${operation}`);
    }
  }

  private requireUploadState(state: Record<string, unknown>): DropboxUploadState {
    if (!isRecord(state)) throw invalidUploadState();
    const { sessionId, nextOffset, parentId, name, expiresAt } = state;
    if (
      typeof sessionId !== 'string'
      || !sessionId
      || typeof nextOffset !== 'number'
      || !Number.isSafeInteger(nextOffset)
      || nextOffset < 0
      || typeof parentId !== 'string'
      || !parentId
      || typeof name !== 'string'
      || typeof expiresAt !== 'number'
      || !Number.isSafeInteger(expiresAt)
    ) throw invalidUploadState();
    return { sessionId, nextOffset, parentId, name: validName(name), expiresAt };
  }

  private requireLiveUploadState(state: Record<string, unknown>): DropboxUploadState {
    const upload = this.requireUploadState(state);
    if (upload.expiresAt <= Date.now()) throw invalidUploadState();
    return upload;
  }
}

export function createDropboxDriver(env: import('../../types').Env, mount: Mount): DropboxDriver {
  return new DropboxDriver(mount, new DropboxClient(env, mount.id));
}
