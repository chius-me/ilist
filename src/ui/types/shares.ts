import type { Entry } from './entries';

export interface ShareView {
  id: string;
  mountId: string;
  mountName: string;
  name: string;
  targetKind: 'file' | 'folder';
  protected: boolean;
  expiresAt: string | null;
  allowDownload: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShareInput {
  entryId: string;
  password?: string;
  expiresAt?: string;
  allowDownload: boolean;
  enabled: boolean;
}

export interface CreatedShare {
  share: ShareView;
  url: string;
}

export interface UpdateShareInput {
  password?: string;
  clearPassword?: boolean;
  expiresAt?: string | null;
  allowDownload?: boolean;
  enabled?: boolean;
}

export interface PublicShareMeta {
  name: string;
  targetKind: 'file' | 'folder';
  allowDownload: boolean;
  protected: boolean;
  expiresAt: string | null;
  entry: Entry;
}
