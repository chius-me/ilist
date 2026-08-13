export type MountDriverType = 's3' | 'onedrive' | 'google' | 'dropbox' | 'pikpak' | 'native-r2';

export interface MountCredentialStatus {
  appConfigured: boolean;
  connected: boolean;
  source: 'mount' | 'legacy' | 'none';
  fields: Record<string, boolean>;
}

export interface S3MountConfig {
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  addressingMode: 'path' | 'virtual-hosted';
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
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  connected: boolean;
  credentialStatus: MountCredentialStatus;
}

interface BaseMountInput {
  name: string;
  mountPath: string;
  provider: string;
  enabled: boolean;
  isPublic: boolean;
  sortOrder: number;
  rootItemId?: string | null;
}

export interface S3MountInput extends BaseMountInput {
  driverType: 's3';
  config: S3MountConfig;
  credentials?: { accessKeyId?: string; secretAccessKey?: string };
}

export interface OneDriveMountInput extends BaseMountInput {
  driverType: 'onedrive';
  provider: 'microsoft-onedrive-personal';
  config: Record<string, never>;
  credentials?: { clientId?: string; clientSecret?: string };
}

export interface GoogleMountInput extends BaseMountInput {
  driverType: 'google';
  provider: 'google';
  config: Record<string, never>;
  credentials?: { clientId?: string; clientSecret?: string };
}

export interface DropboxMountInput extends BaseMountInput {
  driverType: 'dropbox';
  provider: 'dropbox';
  config: Record<string, never>;
  credentials?: { clientId?: string; clientSecret?: string };
}

export interface PikPakMountInput extends BaseMountInput {
  driverType: 'pikpak';
  provider: 'pikpak';
  config: { useTrash: boolean };
  credentials?: { username?: string; password?: string; refreshToken?: string };
}

export type MountInput = S3MountInput | OneDriveMountInput | GoogleMountInput | DropboxMountInput | PikPakMountInput;
