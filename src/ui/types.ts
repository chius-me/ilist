export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: {
    message: string;
  };
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
