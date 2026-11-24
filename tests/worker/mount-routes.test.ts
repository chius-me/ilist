import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { getCredentials, putCredentials } from '../../src/worker/credentials';
import { driverRegistry } from '../../src/worker/drivers/registry';
import { createMount, getMount } from '../../src/worker/mounts';
import { routeRequest } from '../../src/worker/router';
import { createUploadSessionRecord } from '../../src/worker/upload-session-store';
import type { StorageDriver } from '../../src/worker/drivers/types';
import type { Env } from '../../src/worker/types';

const origin = 'https://ilist.example';
const workerEnv = () => env as unknown as Env;

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '127.0.0.1', 'content-type': 'application/json', origin },
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
    delete driverRegistry.google;
    delete driverRegistry.dropbox;
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
    expect((body as { data: Array<{ connected: boolean }> }).data[0]!.connected).toBe(true);
  });

  it('creates mounts as private when the HTTP request omits isPublic', async () => {
    const response = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Private mount',
        mountPath: '/private-mount',
        driverType: 's3',
        provider: 'custom',
        config: s3Config,
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json() as { data: { isPublic: boolean } }).data.isPublic).toBe(false);
  });

  it.each([
    ['OneDrive', 'onedrive', 'microsoft-onedrive-personal'],
    ['Dropbox', 'dropbox', 'dropbox'],
    ['Google Drive', 'google', 'google'],
  ] as const)('creates %s mounts as private when the HTTP request omits isPublic', async (name, driverType, provider) => {
    const response = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mountPath: `/${driverType}`,
        driverType,
        provider,
        config: {},
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json() as { data: { isPublic: boolean } }).data.isPublic).toBe(false);
  });

  it('creates, reports, and disconnects an independently authorized Google mount', async () => {
    const created = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Google Projects',
        mountPath: '/google-projects',
        driverType: 'google',
        provider: 'google',
        rootItemId: 'folder-root-id',
        config: {},
      }),
    });
    expect(created.status).toBe(200);
    const mount = (await created.json() as { data: { id: string; connected: boolean; rootItemId: string; isPublic: boolean } }).data;
    expect(mount).toMatchObject({ connected: false, rootItemId: 'folder-root-id', isPublic: false });

    await putCredentials(workerEnv(), mount.id, {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000,
    });
    const listed = await adminFetch('/api/admin/mounts');
    expect((await listed.json() as { data: Array<{ id: string; connected: boolean }> }).data)
      .toContainEqual(expect.objectContaining({ id: mount.id, connected: true }));

    const disconnected = await adminFetch(`/api/admin/mounts/${mount.id}/disconnect`, { method: 'POST' });
    expect(disconnected.status).toBe(200);
    await expect(getCredentials(workerEnv(), mount.id)).resolves.toBeNull();
    await expect(getMount(workerEnv().DB, mount.id)).resolves.toMatchObject({ driverType: 'google' });
  });

  it('encrypts mount-specific OAuth app credentials and never returns them', async () => {
    const response = await adminFetch('/api/admin/mounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Independent Google', mountPath: '/independent-google', driverType: 'google', provider: 'google',
        config: {}, credentials: { clientId: 'mount-google-id', clientSecret: 'mount-google-secret' },
      }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json() as { data: { id: string; credentialStatus: unknown } }).data;
    await expect(getCredentials(workerEnv(), data.id)).resolves.toMatchObject({
      app: { clientId: 'mount-google-id', clientSecret: 'mount-google-secret' },
    });
    expect(JSON.stringify(data)).not.toContain('mount-google');
    const row = await workerEnv().DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?').bind(data.id).first<{ ciphertext: string }>();
    expect(row?.ciphertext).not.toContain('mount-google-secret');
  });

  it('disconnects OAuth account tokens while preserving application credentials', async () => {
    const created = await adminFetch('/api/admin/mounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Dropbox app', mountPath: '/dropbox-app', driverType: 'dropbox', provider: 'dropbox', config: {},
        credentials: { clientId: 'dropbox-id', clientSecret: 'dropbox-secret' },
      }),
    });
    const mountId = (await created.json() as { data: { id: string } }).data.id;
    await putCredentials(workerEnv(), mountId, {
      app: { clientId: 'dropbox-id', clientSecret: 'dropbox-secret' },
      auth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000 },
    });
    const response = await adminFetch(`/api/admin/mounts/${mountId}/disconnect`, { method: 'POST' });
    expect(response.status).toBe(200);
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({
      app: { clientId: 'dropbox-id', clientSecret: 'dropbox-secret' },
    });
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
    expect(await getCredentials(workerEnv(), mountId)).toEqual({ provider: {
      accessKeyId: 'updated-key', secretAccessKey: 'initial-secret',
    } });
    expect(JSON.stringify(await response.json())).not.toContain('secretAccessKey');
  });

  it.each(['pikpak', 'native-r2'] as const)('rejects creation and modification of retired %s mounts while allowing deletion', async (retiredType) => {
    const rejected = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Retired ${retiredType}`, mountPath: `/retired-${retiredType}`, driverType: retiredType, provider: retiredType, config: {},
      }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'INVALID_MOUNT_DRIVER' } });

    const mount = await createMount(workerEnv().DB, {
      name: `Legacy ${retiredType}`, mountPath: `/legacy-${retiredType}`, driverType: retiredType, provider: retiredType,
      enabled: false, isPublic: false, rootItemId: 'root', config: {},
    });
    await putCredentials(workerEnv(), mount.id, { auth: { refreshToken: 'retired-refresh-token' } });

    const patchRejected = await adminFetch(`/api/admin/mounts/${mount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, isPublic: true }),
    });
    expect(patchRejected.status).toBe(400);
    await expect(patchRejected.json()).resolves.toMatchObject({ error: { code: 'DRIVER_RETIRED' } });

    const listResponse = await adminFetch('/api/admin/mounts');
    const listed = (await listResponse.json() as { data: Array<Record<string, unknown>> }).data
      .find((candidate) => candidate.id === mount.id);
    expect(listed).toMatchObject({ connected: false, config: {} });

    const deleteResponse = await adminFetch(`/api/admin/mounts/${mount.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(204);
    await expect(getMount(workerEnv().DB, mount.id)).resolves.toBeNull();
    await expect(getCredentials(workerEnv(), mount.id)).resolves.toBeNull();
  });

  it('rejects reserved mount paths including /s', async () => {
    const response = await adminFetch('/api/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Share collision', mountPath: '/s', driverType: 's3', provider: 'custom',
        config: s3Config, credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'RESERVED_MOUNT_PATH' } });
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

  it('blocks private/loopback S3 endpoints in HTTPS production while allowing localhost under local PUBLIC_ORIGIN', async () => {
    for (const badConfig of [
      { ...s3Config, endpoint: 'http://[::1]:9000' },
      { ...s3Config, endpoint: 'https://169.254.169.254' },
      { ...s3Config, endpoint: 'https://10.0.0.1:9000' },
      { ...s3Config, endpoint: 'https://[::ffff:127.0.0.1]' },
      { ...s3Config, bucket: '../bad-bucket' },
      { ...s3Config, bucket: 'bad_bucket', addressingMode: 'virtual-hosted' },
      { ...s3Config, region: 'us-east-1/evil' },
    ]) {
      const rejected = await adminFetch('/api/admin/mounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `Bad ${crypto.randomUUID()}`,
          mountPath: `/bad-${crypto.randomUUID()}`,
          driverType: 's3',
          provider: 'custom',
          config: badConfig,
          credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
        }),
      });
      expect(rejected.status).toBe(400);
    }

    const cookie = await login();
    const localEnv = { ...workerEnv(), PUBLIC_ORIGIN: 'http://localhost:8787' };
    const localResponse = await routeRequest(new Request('http://localhost:8787/api/admin/mounts', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost:8787', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'IPv6 local',
        mountPath: '/ipv6-local',
        driverType: 's3',
        provider: 'custom',
        config: { ...s3Config, endpoint: 'http://[::1]:9000' },
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    }), localEnv);

    expect(localResponse.status).toBe(200);
  });

  it('aborts active remote multipart uploads before deleting a mount', async () => {
    const mountId = await createS3Mount();
    const abort = vi.fn(async () => undefined);
    driverRegistry.s3 = () => ({
      rootId: 'root',
      capabilities: new Set(['list', 'upload', 'multipartUpload']),
      resumableUpload: {
        create: vi.fn(),
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort,
      },
      list: vi.fn(),
      stat: vi.fn(),
      isWithin: vi.fn(),
      getDownload: vi.fn(),
      createFolder: vi.fn(),
      upload: vi.fn(),
      rename: vi.fn(),
      move: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
    } as unknown as StorageDriver);

    const cookie = await login();
    const me = await SELF.fetch(`${origin}/api/admin/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const sessionRow = await workerEnv().DB.prepare('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1').first<{ id: string }>();
    await createUploadSessionRecord(workerEnv(), sessionRow!.id, {
      mountId,
      parentItemId: 'root',
      name: 'pending.bin',
      size: 20 * 1024 * 1024,
      contentType: 'application/octet-stream',
      partSize: 10 * 1024 * 1024,
      providerState: { uploadId: 's3-upload-id', key: 'pending.bin' },
      expiresAt: Date.now() + 60_000,
    });

    const deleted = await SELF.fetch(`${origin}/api/admin/mounts/${mountId}`, {
      method: 'DELETE',
      headers: { cookie, origin },
    });
    expect(deleted.status).toBe(204);
    expect(abort).toHaveBeenCalledWith({ uploadId: 's3-upload-id', key: 'pending.bin' });
  });

  it('tests the selected mount through its registered driver', async () => {
    const mountId = await createS3Mount();
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    driverRegistry.s3 = vi.fn().mockResolvedValue({ rootId: 'driver-root', list } as unknown as StorageDriver);

    const response = await adminFetch(`/api/admin/mounts/${mountId}/test`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith('driver-root');
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
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({ provider: {
      accessKeyId: 'initial-key', secretAccessKey: 'initial-secret',
    } });
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
      body: JSON.stringify({ driverType: 'onedrive', config: {} }),
    });

    expect(response.status).toBe(500);
    await expect(getMount(workerEnv().DB, mountId)).resolves.toMatchObject({ driverType: 's3', config: s3Config });
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({ provider: {
      accessKeyId: 'initial-key', secretAccessKey: 'initial-secret',
    } });
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
    await expect(getCredentials(workerEnv(), mountId)).resolves.toEqual({ provider: {
      accessKeyId: 'initial-key', secretAccessKey: 'initial-secret',
    } });
  });
});
