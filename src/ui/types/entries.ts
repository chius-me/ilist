export type EntryKind = 'file' | 'folder';

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

export interface AdminUser {
  username: string;
}

export type EntryPatch = {
  name?: string;
  description?: string;
  sortOrder?: number;
  isPublic?: boolean;
};
