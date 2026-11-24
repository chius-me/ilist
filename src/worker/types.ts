export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH: string;
  CREDENTIAL_MASTER_KEY: string;
  SESSION_SECRET: string;
  SESSION_TTL_SECONDS?: string;
  /** Legacy deployment-level fallback. New mounts store provider credentials encrypted per mount. */
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DROPBOX_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  PUBLIC_ORIGIN: string;
}

export interface AdminUser {
  username: string;
}

export type EntryKind = 'file' | 'folder';

export interface ShareRow {
  id: string;
  token_hash: string;
  mount_id: string;
  provider_item_id: string;
  target_kind: EntryKind;
  name: string;
  password_hash: string | null;
  auth_revision: number;
  expires_at: number | null;
  allow_download: number;
  enabled: number;
  download_count: number;
  max_downloads: number | null;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export interface Share {
  id: string;
  tokenHash: string;
  mountId: string;
  providerItemId: string;
  targetKind: EntryKind;
  name: string;
  passwordHash: string | null;
  authRevision: number;
  expiresAt: number | null;
  allowDownload: boolean;
  enabled: boolean;
  downloadCount: number;
  maxDownloads: number | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntryCapabilities {
  open: boolean;
  preview: boolean;
  download: boolean;
  upload: boolean;
  multipartUpload?: boolean;
  createFolder: boolean;
  rename: boolean;
  move: boolean;
  copy: boolean;
  delete: boolean;
  changeVisibility: boolean;
}

export interface FileExportOption {
  format: string;
  label: string;
  extension: string;
  contentType: string;
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
  mountPath: string | null;
  exportOptions?: FileExportOption[];
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
  nextCursor?: string | null;
}

export interface MountEntry extends Entry {
  mountId: string;
  mountPath: string;
  driverType: MountDriverType;
  provider: string;
}

export interface VirtualDirectoryResponse {
  current: Entry | MountEntry;
  breadcrumbs: Breadcrumb[];
  items: Array<Entry | MountEntry>;
  nextCursor?: string | null;
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

// `pikpak` and `native-r2` remain only so legacy database rows can be listed and deleted safely.
export type MountDriverType = 's3' | 'onedrive' | 'google' | 'dropbox' | 'pikpak' | 'native-r2';

export interface MountRow {
  id: string;
  name: string;
  mount_path: string;
  driver_type: MountDriverType;
  provider: string;
  enabled: number;
  is_public: number;
  sort_order: number;
  root_item_id: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface Mount {
  id: string;
  name: string;
  mountPath: string;
  driverType: MountDriverType;
  provider: string;
  enabled: boolean;
  isPublic: boolean;
  sortOrder: number;
  rootItemId: string | null;
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

export type UploadSessionStatus = 'active' | 'completing' | 'completed' | 'aborted';
export type UploadTerminalOperation = 'complete' | 'abort';

export interface UploadSessionRow {
  id: string;
  owner_session_id: string;
  mount_id: string;
  parent_item_id: string;
  name: string;
  size: number;
  content_type: string | null;
  part_size: number;
  provider_state_ciphertext: string;
  parts_json: string;
  completed_item_json: string | null;
  status: UploadSessionStatus;
  active_part_number: number | null;
  active_part_expires_at: number | null;
  terminal_operation: UploadTerminalOperation | null;
  terminal_owner: string | null;
  terminal_expires_at: number | null;
  cleanup_attempted_at: number;
  expires_at: number;
  created_at: string;
  updated_at: string;
}
