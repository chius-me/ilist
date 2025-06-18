export interface Env {
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  SESSION_TTL_SECONDS?: string;
}

export interface ObjectRow {
  key: string;
  name: string;
  size: number;
  content_type: string | null;
  etag: string | null;
  updated_at: string;
  is_public: number;
  sort_order: number;
  description: string;
}

export interface DirectoryEntry {
  name: string;
  key: string;
  type: 'directory';
}

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  contentType: string | null;
  etag: string | null;
  updatedAt: string;
  isPublic: boolean;
  sortOrder: number;
  description: string;
  type: 'file';
}

export interface TreeResponse {
  prefix: string;
  directories: DirectoryEntry[];
  files: FileEntry[];
}

export interface AdminUser {
  username: string;
}

export type EntryKind = 'file' | 'folder';
export type EntryStatus = 'uploading' | 'ready' | 'deleting';

export interface EntryRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: EntryKind;
  storage_key: string | null;
  size: number;
  content_type: string | null;
  etag: string | null;
  status: EntryStatus;
  is_public: number;
  sort_order: number;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface EntryCapabilities {
  open: boolean;
  preview: boolean;
  download: boolean;
  rename: boolean;
  move: boolean;
  delete: boolean;
  changeVisibility: boolean;
}

export interface Entry {
  id: string;
  parentId: string | null;
  name: string;
  kind: EntryKind;
  size: number;
  contentType: string | null;
  updatedAt: string;
  isPublic: boolean;
  effectivePublic: boolean;
  sortOrder: number;
  description: string;
  capabilities: EntryCapabilities;
}

export interface Breadcrumb {
  id: string;
  name: string;
  path: string;
}

export interface DirectoryResponse {
  current: Entry;
  breadcrumbs: Breadcrumb[];
  items: Entry[];
}

export interface BatchFailure {
  id: string;
  code: string;
  message: string;
}

export interface BatchResult {
  succeeded: string[];
  failed: BatchFailure[];
}
