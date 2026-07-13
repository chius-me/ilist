import {
  deleteCredentials,
  getCredentials,
  prepareDeleteCredentials,
  preparePutCredentials,
  putCredentials,
  type StorageCredentials,
} from './credentials';
import { createDriver } from './drivers/registry';
import { fail, HttpError, noContent, ok, readJson } from './http';
import {
  createMount,
  deleteMount,
  getMount,
  listMounts,
  prepareMountDelete,
  prepareMountUpdate,
  rethrowMountWriteError,
  type CreateMountInput,
  type UpdateMountInput,
} from './mounts';
import type { Env, Mount, MountDriverType } from './types';

interface MountRequestBody {
  name?: unknown;
  mountPath?: unknown;
  driverType?: unknown;
  provider?: unknown;
  enabled?: unknown;
  isPublic?: unknown;
  sortOrder?: unknown;
  rootItemId?: unknown;
  config?: unknown;
  credentials?: unknown;
}

interface S3Config extends Record<string, unknown> {
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  addressingMode: 'path' | 'virtual-hosted';
}

interface S3Credentials extends StorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const MOUNT_DRIVER_TYPES = new Set<MountDriverType>(['s3', 'onedrive', 'native-r2']);

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

function invalidRequest(code = 'INVALID_REQUEST', message = 'Invalid request body'): never {
  throw new HttpError(400, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) invalidRequest(code);
  return value;
}

function optionalString(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, code);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalidRequest();
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') invalidRequest();
  return value;
}

function optionalRootItemId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredString(value, 'INVALID_MOUNT_ROOT_ITEM');
}

function driverType(value: unknown): MountDriverType {
  if (typeof value !== 'string' || !MOUNT_DRIVER_TYPES.has(value as MountDriverType)) {
    invalidRequest('INVALID_MOUNT_DRIVER', 'Mount driver is invalid');
  }
  return value as MountDriverType;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidRequest(code);
}

function validateS3Endpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    invalidRequest('INVALID_MOUNT_CONFIG', 'S3 endpoint is invalid');
  }

  const localHost = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '::1'
    || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) || url.username || url.password || url.search || url.hash) {
    invalidRequest('INVALID_MOUNT_CONFIG', 'S3 endpoint must use HTTPS');
  }
}

function validateS3Config(value: unknown): S3Config {
  if (!isRecord(value)) invalidRequest('INVALID_MOUNT_CONFIG', 'S3 configuration is invalid');
  assertOnlyKeys(value, ['endpoint', 'region', 'bucket', 'rootPrefix', 'addressingMode'], 'INVALID_MOUNT_CONFIG');
  const endpoint = requiredString(value.endpoint, 'INVALID_MOUNT_CONFIG');
  validateS3Endpoint(endpoint);
  const region = requiredString(value.region, 'INVALID_MOUNT_CONFIG');
  const bucket = requiredString(value.bucket, 'INVALID_MOUNT_CONFIG');
  const rootPrefix = optionalString(value.rootPrefix, 'INVALID_MOUNT_CONFIG');
  if (value.addressingMode !== 'path' && value.addressingMode !== 'virtual-hosted') {
    invalidRequest('INVALID_MOUNT_CONFIG', 'S3 addressing mode is invalid');
  }
  return { endpoint, region, bucket, ...(rootPrefix === undefined ? {} : { rootPrefix }), addressingMode: value.addressingMode };
}

function validateConfig(driver: MountDriverType, value: unknown): Record<string, unknown> {
  if (driver === 's3') return validateS3Config(value);
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    invalidRequest('INVALID_MOUNT_CONFIG', 'Mount configuration is invalid');
  }
  return {};
}

function sanitizedConfig(mount: Mount): Record<string, unknown> {
  if (mount.driverType !== 's3' || !isRecord(mount.config)) return {};
  const config = mount.config;
  const result: Record<string, unknown> = {};
  for (const key of ['endpoint', 'region', 'bucket', 'rootPrefix', 'addressingMode']) {
    if (typeof config[key] === 'string') result[key] = config[key];
  }
  return result;
}

function mountToApi(mount: Mount): Omit<Mount, 'config'> & { config: Record<string, unknown> } {
  return { ...mount, config: sanitizedConfig(mount) };
}

function existingS3Credentials(value: StorageCredentials | null): S3Credentials | null {
  if (!value || typeof value.accessKeyId !== 'string' || typeof value.secretAccessKey !== 'string') return null;
  return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey };
}

function mergeS3Credentials(value: unknown, existing: StorageCredentials | null): S3Credentials {
  if (!isRecord(value)) invalidRequest('INVALID_MOUNT_CREDENTIALS', 'S3 credentials are invalid');
  assertOnlyKeys(value, ['accessKeyId', 'secretAccessKey'], 'INVALID_MOUNT_CREDENTIALS');
  if (value.accessKeyId !== undefined && (typeof value.accessKeyId !== 'string' || !value.accessKeyId.trim())) {
    invalidRequest('INVALID_MOUNT_CREDENTIALS', 'S3 access key is invalid');
  }
  if (value.secretAccessKey !== undefined && typeof value.secretAccessKey !== 'string') {
    invalidRequest('INVALID_MOUNT_CREDENTIALS', 'S3 secret key is invalid');
  }

  const prior = existingS3Credentials(existing);
  const accessKeyId = value.accessKeyId ?? prior?.accessKeyId;
  const secretAccessKey = value.secretAccessKey === '' ? prior?.secretAccessKey : value.secretAccessKey ?? prior?.secretAccessKey;
  if (typeof accessKeyId !== 'string' || !accessKeyId.trim() || typeof secretAccessKey !== 'string' || !secretAccessKey) {
    invalidRequest('INVALID_MOUNT_CREDENTIALS', 'S3 credentials are incomplete');
  }
  return { accessKeyId, secretAccessKey };
}

async function credentialsForUpdate(
  driver: MountDriverType,
  rawCredentials: unknown,
  existing: StorageCredentials | null,
  driverChanged: boolean,
): Promise<StorageCredentials | null | undefined> {
  if (rawCredentials === undefined) return driverChanged ? null : undefined;
  if (driver !== 's3') {
    invalidRequest('INVALID_MOUNT_CREDENTIALS', 'Credentials are managed by the provider connection flow');
  }
  return mergeS3Credentials(rawCredentials, driverChanged ? null : existing);
}

function createInput(body: MountRequestBody): CreateMountInput {
  const selectedDriver = driverType(body.driverType);
  return {
    name: requiredString(body.name, 'INVALID_MOUNT_NAME'),
    mountPath: requiredString(body.mountPath, 'INVALID_MOUNT_PATH'),
    driverType: selectedDriver,
    provider: requiredString(body.provider, 'INVALID_MOUNT_PROVIDER'),
    ...(optionalBoolean(body.enabled) === undefined ? {} : { enabled: optionalBoolean(body.enabled) }),
    ...(optionalBoolean(body.isPublic) === undefined ? {} : { isPublic: optionalBoolean(body.isPublic) }),
    ...(optionalNumber(body.sortOrder) === undefined ? {} : { sortOrder: optionalNumber(body.sortOrder) }),
    ...(optionalRootItemId(body.rootItemId) === undefined ? {} : { rootItemId: optionalRootItemId(body.rootItemId) }),
    config: validateConfig(selectedDriver, body.config),
  };
}

function updateInput(body: MountRequestBody, current: Mount): UpdateMountInput {
  const selectedDriver = body.driverType === undefined ? current.driverType : driverType(body.driverType);
  const config = body.config === undefined ? current.config : body.config;
  return {
    ...(body.name === undefined ? {} : { name: requiredString(body.name, 'INVALID_MOUNT_NAME') }),
    ...(body.mountPath === undefined ? {} : { mountPath: requiredString(body.mountPath, 'INVALID_MOUNT_PATH') }),
    ...(body.driverType === undefined ? {} : { driverType: selectedDriver }),
    ...(body.provider === undefined ? {} : { provider: requiredString(body.provider, 'INVALID_MOUNT_PROVIDER') }),
    ...(optionalBoolean(body.enabled) === undefined ? {} : { enabled: optionalBoolean(body.enabled) }),
    ...(optionalBoolean(body.isPublic) === undefined ? {} : { isPublic: optionalBoolean(body.isPublic) }),
    ...(optionalNumber(body.sortOrder) === undefined ? {} : { sortOrder: optionalNumber(body.sortOrder) }),
    ...(optionalRootItemId(body.rootItemId) === undefined ? {} : { rootItemId: optionalRootItemId(body.rootItemId) }),
    config: validateConfig(selectedDriver, config),
  };
}

function requestBody(body: unknown): MountRequestBody {
  if (!isRecord(body)) invalidRequest();
  return body;
}

function mountIdFromPath(pathname: string, suffix = ''): string | null {
  const match = new RegExp(`^/api/admin/mounts/([^/]+)${suffix}$`).exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    invalidRequest();
  }
}

async function requireMount(env: Env, id: string): Promise<Mount> {
  const mount = await getMount(env.DB, id);
  if (!mount) throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Mount not found');
  return mount;
}

export async function handleMountRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/admin/mounts') {
    if (request.method === 'GET') return ok((await listMounts(env.DB)).map(mountToApi));
    if (request.method !== 'POST') return methodNotAllowed();

    const body = requestBody(await readJson<unknown>(request));
    const input = createInput(body);
    const credentials = await credentialsForUpdate(input.driverType, body.credentials, null, false);
    const mount = await createMount(env.DB, input);
    try {
      if (credentials) await putCredentials(env, mount.id, credentials);
    } catch (error) {
      await deleteMount(env.DB, mount.id);
      throw error;
    }
    return ok(mountToApi(mount));
  }

  const disconnectId = mountIdFromPath(url.pathname, '/disconnect');
  if (disconnectId !== null) {
    if (request.method !== 'POST') return methodNotAllowed();
    const mount = await requireMount(env, disconnectId);
    await deleteCredentials(env, mount.id);
    return ok(mountToApi(mount));
  }

  const testId = mountIdFromPath(url.pathname, '/test');
  if (testId !== null) {
    if (request.method !== 'POST') return methodNotAllowed();
    const mount = await requireMount(env, testId);
    const driver = await createDriver(env, mount);
    await driver.list(mount.rootItemId ?? '');
    return ok({});
  }

  const id = mountIdFromPath(url.pathname);
  if (id === null) return null;
  if (request.method === 'DELETE') {
    const mount = await requireMount(env, id);
    await env.DB.batch([
      prepareDeleteCredentials(env.DB, mount.id),
      prepareMountDelete(env.DB, mount.id),
    ]);
    return noContent();
  }
  if (request.method !== 'PATCH') return methodNotAllowed();

  const current = await requireMount(env, id);
  const body = requestBody(await readJson<unknown>(request));
  const input = updateInput(body, current);
  const selectedDriver = input.driverType ?? current.driverType;
  const credentials = await credentialsForUpdate(
    selectedDriver,
    body.credentials,
    await getCredentials(env, current.id),
    selectedDriver !== current.driverType,
  );
  const update = await prepareMountUpdate(env.DB, current.id, input);
  if (!update) throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Mount not found');
  const credentialStatement = credentials === null
    ? prepareDeleteCredentials(env.DB, update.id)
    : credentials
      ? await preparePutCredentials(env, update.id, credentials)
      : null;
  try {
    await env.DB.batch([update.statement, ...(credentialStatement ? [credentialStatement] : [])]);
  } catch (error) {
    await rethrowMountWriteError(env.DB, error, update);
  }
  const mount = await getMount(env.DB, update.id);
  if (!mount) throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Mount not found');
  return ok(mountToApi(mount));
}
