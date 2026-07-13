import type { StorageCredentials } from '../credentials';
import type { Env, Mount, MountDriverType } from '../types';

export type DriverCapability =
  | 'list'
  | 'download'
  | 'upload'
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
}

export interface ListResult {
  items: StorageItem[];
  nextCursor: string | null;
}

export type DownloadResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; response: Response };

export interface StorageDriver {
  readonly capabilities: ReadonlySet<DriverCapability>;
  list(parentId: string, cursor?: string): Promise<ListResult>;
  stat(itemId: string): Promise<StorageItem>;
  getDownload(itemId: string, request: Request): Promise<DownloadResult>;
  createFolder(parentId: string, name: string): Promise<StorageItem>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<StorageItem>;
  rename(itemId: string, name: string): Promise<StorageItem>;
  move(itemId: string, destinationId: string): Promise<StorageItem>;
  remove(itemId: string): Promise<void>;
}

export type StorageDriverFactory = (
  env: Env,
  mount: Mount,
  credentials: StorageCredentials | null,
) => StorageDriver | Promise<StorageDriver>;

export type DriverRegistry = Partial<Record<MountDriverType, StorageDriverFactory>>;
