import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { getCredentials } from '../../src/worker/credentials';
import { driverRegistry } from '../../src/worker/drivers/registry';
import { getMount } from '../../src/worker/mounts';
import type { StorageDriver } from '../../src/worker/drivers/types';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const workerEnv = () => env as unknown as Env;

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = await login();
  return SELF.fetch(`${origin}${path}`, {
    ...init,
    headers: { cookie, origin, ...init.headers },
  });
}

const s3Config = {
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'photos',
  rootPrefix: 'albums/',
  addressingMode: 'path',
};

async function createS3Mount(): Promise<string> {
  const response = await adminFetch('/api/admin/mounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Photos',
      mountPath: '/photos',
      driverType: 's3',
      provider: 'custom',
      rootItemId: 'root',
      config: s3Config,
      credentials: { accessKeyId: 'initial-key', secretAccessKey: 'initial-secret' },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { data: { id: string } }).data.id;
}

async function dropFailureTriggers(): Promise<void> {
  await workerEnv().DB.prepare('DROP TRIGGER IF EXISTS fail_credential_write').run();
  await workerEnv().DB.prepare('DROP TRIGGER IF EXISTS fail_credential_delete').run();
  await workerEnv().DB.prepare('DROP TRIGGER IF EXISTS fail_mount_delete').run();
}

describe('mount administration API', () => {
  beforeEach(async () => {
    await dropFailureTriggers();
    delete driverRegistry.s3;
    delete driverRegistry.onedrive;
    delete driverRegistry['native-r2'];
    await workerEnv().DB.prepare('DELETE FROM storage_credentials').run();
    await workerEnv().DB.prepare('DELETE FROM mounts').run();
  });

  afterEach(dropFailureTriggers);

  it('never returns stored credentials', async () => {
    await createS3Mount();

    const response = await adminFetch('/api/admin/mounts');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('initial-secret');
    expect(JSON.stringify(body)).not.toContain('secretAccessKey');
    expect(JSON.stringify(body)).not.toContain('accessKeyId');
  });

  it('creates an S3 mount and preserves a blank secret on update', async () => {
    const mountId = await createS3Mount();

    const response = await adminFetch(`/api/admin/mounts/${mountId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config: { ...s3Config, rootPrefix: 'archive/' },
        credentials: { accessKeyId: 'updated-key', secretAccessKey: '' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await getCredentials(workerEnv(), mountId)).toEqual({
      accessKeyId: 'updated-key',
      secretAccessKey: 'initial-secret',
    });
    expect(JSON.stringify(await response.json())).not.toContain('secretAccessKey');
  });

  it('validates S3 configuration and returns mount path conflicts', async () => {
    const invalid = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Insecure',
        mountPath: '/insecure',
        driverType: 's3',
        provider: 'custom',
        config: { ...s3Config, endpoint: 'http://s3.example.test' },
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    });
    expect(invalid.status).toBe(400);

    await createS3Mount();
    const collision = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Photos copy',
        mountPath: '/photos',
        driverType: 's3',
        provider: 'custom',
        config: s3Config,
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    });

    expect(collision.status).toBe(409);
    expect((await collision.json() as { error: { code: string } }).error.code).toBe('MOUNT_PATH_CONFLICT');
  });

  it('allows an IPv6 localhost S3 endpoint for local development', async () => {
    const response = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'IPv6 local',
        mountPath: '/ipv6-local',
        driverType: 's3',
        provider: 'custom',
        config: { ...s3Config, endpoint: 'http://[::1]:9000' },
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    });

    expect(response.status).toBe(200);
  });

  it('tests the selected mount through its registered driver', async () => {
    const mountId = await createS3Mount();
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    driverRegistry.s3 = vi.fn().mockResolvedValue({ list } as unknown as StorageDriver);

    const response = await adminFetch(`/api/admin/mounts/${mountId}/test`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith('root');
  });

  it('disconnects credentials and deletes only local mount records', async () => {
    const mountId = await createS3Mount();

    const disconnect = await adminFetch(`/api/admin/mounts/${mountId}/disconnect`, { method: 'POST' });
    expect(disconnect.status).toBe(200);
    await expect(getCredentials(workerEnv(), mountId)).resolves.toBeNull();
    await expect(getMount(workerEnv().DB, mountId)).resolves.not.toBeNull();

    const remove = await adminFetch(`/api/admin/mounts/${mountId}`, { method: 'DELETE' });
    expect(remove.status).toBe(204);
    await expect(getMount(workerEnv().DB, mountId)).resolves.toBeNull();
    await expect(getCredentials(workerEnv(), mountId)).resolves.toBeNull();
  });

  it('rolls back configuration and credential changes when the credential write fails', async () => {
    const mountId = await createS3Mount();
    await workerEnv().DB.prepare(
      `CREATE TRIGGER fail_credential_write BEFORE INSERT ON storage_credentials
       BEGIN SELECT RAISE(ABORT, 'forced credential write failure'); END`,
    ).run();

    const response = await adminFetch(`/api/admin/mounts/${mountId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config: { ...s3Config, rootPrefix: 'changed/' },
        credentials: { accessKeyId: 'changed-key', secretAccessKey: 'changed-secret' },
      }),
    });

    expect(response.status).toBe(500);
    await expect(getMount(workerEnv().DB, mountId)).resolves.toMatchObject({ config: s3Config });
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({
      accessKeyId: 'initial-key',
      secretAccessKey: 'initial-secret',
    });
  });

  it('rolls back driver and configuration changes when credential deletion fails', async () => {
    const mountId = await createS3Mount();
    await workerEnv().DB.prepare(
      `CREATE TRIGGER fail_credential_delete BEFORE DELETE ON storage_credentials
       BEGIN SELECT RAISE(ABORT, 'forced credential delete failure'); END`,
    ).run();

    const response = await adminFetch(`/api/admin/mounts/${mountId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driverType: 'native-r2', config: {} }),
    });

    expect(response.status).toBe(500);
    await expect(getMount(workerEnv().DB, mountId)).resolves.toMatchObject({ driverType: 's3', config: s3Config });
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({
      accessKeyId: 'initial-key',
      secretAccessKey: 'initial-secret',
    });
  });

  it('leaves both local records unchanged when mount deletion fails', async () => {
    const mountId = await createS3Mount();
    await workerEnv().DB.prepare(
      `CREATE TRIGGER fail_mount_delete BEFORE DELETE ON mounts
       BEGIN SELECT RAISE(ABORT, 'forced mount delete failure'); END`,
    ).run();

    const response = await adminFetch(`/api/admin/mounts/${mountId}`, { method: 'DELETE' });

    expect(response.status).toBe(500);
    await expect(getMount(workerEnv().DB, mountId)).resolves.not.toBeNull();
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({
      accessKeyId: 'initial-key',
      secretAccessKey: 'initial-secret',
    });
  });
});
