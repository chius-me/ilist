import { getCredentials } from '../credentials';
import { HttpError } from '../http';
import type { Env, Mount } from '../types';
import { S3Client } from './s3/client';
import { S3Driver } from './s3/driver';
import { OneDriveClient } from './onedrive/client';
import { OneDriveDriver } from './onedrive/driver';
import { createGoogleDriveDriver } from './google/driver';
import type { DriverRegistry, StorageDriver } from './types';

export const driverRegistry: DriverRegistry = {
  s3: (_env, mount, credentials) => {
    const config = mount.config as Record<string, unknown>;
    if (
      typeof config?.endpoint !== 'string'
      || typeof config.region !== 'string'
      || typeof config.bucket !== 'string'
      || (config.addressingMode !== 'path' && config.addressingMode !== 'virtual-hosted')
      || !credentials
      || typeof credentials.accessKeyId !== 'string'
      || typeof credentials.secretAccessKey !== 'string'
    ) {
      throw new HttpError(500, 'INVALID_MOUNT_CONFIGURATION', 'S3 mount configuration is incomplete');
    }
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      addressingStyle: config.addressingMode === 'virtual-hosted' ? 'virtual' : 'path',
      credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    });
    return new S3Driver(mount, client);
  },
  onedrive: (env, mount) => new OneDriveDriver(mount, new OneDriveClient(env, mount.id)),
  google: (env, mount) => createGoogleDriveDriver(env, mount),
};

export async function createDriver(env: Env, mount: Mount, registry: DriverRegistry = driverRegistry): Promise<StorageDriver> {
  if (!mount.enabled) {
    throw new HttpError(403, 'MOUNT_DISABLED', 'Mount is disabled');
  }

  const factory = registry[mount.driverType];
  if (!factory) {
    throw new HttpError(503, 'DRIVER_UNAVAILABLE', 'Storage driver is unavailable');
  }

  const credentials = await getCredentials(env, mount.id);
  return factory(env, mount, credentials);
}
