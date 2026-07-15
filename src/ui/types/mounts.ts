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
}

export interface MountInput {
  name: string;
  mountPath: string;
  driverType: 's3';
  provider: string;
  enabled: boolean;
  isPublic: boolean;
  sortOrder: number;
  config: S3MountConfig;
  credentials?: { accessKeyId?: string; secretAccessKey?: string };
}
