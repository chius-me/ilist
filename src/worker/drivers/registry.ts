import { getCredentials } from '../credentials';
import { HttpError } from '../http';
import type { Env, Mount } from '../types';
import type { DriverRegistry, StorageDriver } from './types';

export const driverRegistry: DriverRegistry = {};

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
