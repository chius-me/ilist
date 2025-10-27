export type MountDriverType = 's3' | 'onedrive' | 'native-r2';

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
}

interface BaseMountInput {
  name: string;
  mountPath: string;
  provider: string;
  enabled: boolean;
  isPublic: boolean;
  sortOrder: number;
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
}

export type MountInput = S3MountInput | OneDriveMountInput;
