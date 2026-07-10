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
