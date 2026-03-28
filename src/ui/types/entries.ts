export type EntryKind = 'file' | 'folder';

export interface EntryCapabilities {
  open: boolean;
  preview: boolean;
  download: boolean;
  upload: boolean;
  multipartUpload?: boolean;
  createFolder: boolean;
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
  mountPath: string | null;
  capabilities: EntryCapabilities;
}

export function isEntryMutable(entry: Entry): boolean {
  const capabilities = entry.capabilities;
  return capabilities.rename || capabilities.move || capabilities.delete || capabilities.changeVisibility;
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
