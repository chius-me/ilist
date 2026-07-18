import type { StorageCredentials } from '../credentials';
import type { Env, FileExportOption, Mount, MountDriverType } from '../types';

export type DriverCapability =
  | 'list'
  | 'download'
  | 'upload'
  | 'multipartUpload'
  | 'createFolder'
  | 'rename'
  | 'move'
  | 'delete';

export interface StorageItem {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  size: number | null;
  contentType: string | null;
  modifiedAt: string | null;
  etag: string | null;
  exportOptions?: FileExportOption[];
}

export const LARGE_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_PART_SIZE_BYTES = 10 * 1024 * 1024;

export interface CompletedUploadPart {
  partNumber: number;
  size: number;
  etag: string | null;
}

export interface ProviderUploadSession {
  state: Record<string, unknown>;
  expiresAt: number;
}

export interface ProviderUploadPartResult {
  state?: Record<string, unknown>;
  part: CompletedUploadPart;
  completedItem?: StorageItem;
}

export interface ResumableUploadAdapter {
  create(input: {
    parentId: string;
    name: string;
    size: number;
    contentType: string | null;
    partSize: number;
  }): Promise<ProviderUploadSession>;
  uploadPart(input: {
    state: Record<string, unknown>;
    partNumber: number;
    offset: number;
    totalSize: number;
    body: ReadableStream;
    size: number;
    signal: AbortSignal;
  }): Promise<ProviderUploadPartResult>;
  complete(input: {
    state: Record<string, unknown>;
    parts: CompletedUploadPart[];
    completedItem?: StorageItem;
  }): Promise<StorageItem>;
  abort(state: Record<string, unknown>): Promise<void>;
}

export interface ListResult {
  items: StorageItem[];
  nextCursor: string | null;
}

export type DownloadResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; response: Response };

export interface StorageDriver {
  readonly rootId: string;
  readonly capabilities: ReadonlySet<DriverCapability>;
  readonly resumableUpload?: ResumableUploadAdapter;
  list(parentId: string, cursor?: string): Promise<ListResult>;
  stat(itemId: string): Promise<StorageItem>;
  getDownload(itemId: string, request: Request): Promise<DownloadResult>;
  createFolder(parentId: string, name: string): Promise<StorageItem>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<StorageItem>;
  rename(itemId: string, name: string): Promise<StorageItem>;
  move(itemId: string, destinationId: string): Promise<StorageItem>;
  remove(itemId: string): Promise<void>;
}

export function requireResumableUploadAdapter(
  driver: StorageDriver,
): driver is StorageDriver & { readonly resumableUpload: ResumableUploadAdapter } {
  return driver.capabilities.has('multipartUpload') && driver.resumableUpload !== undefined;
}

export type StorageDriverFactory = (
  env: Env,
  mount: Mount,
  credentials: StorageCredentials | null,
) => StorageDriver | Promise<StorageDriver>;

export type DriverRegistry = Partial<Record<MountDriverType, StorageDriverFactory>>;
