import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createMount, deleteMount, getMount, listMounts, normalizeMountPath, updateMount } from '../../src/worker/mounts';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

describe('mounts', () => {
  beforeEach(async () => {
    await db().prepare('DELETE FROM mounts').run();
  });

  it('normalizes a single decoded mount path segment', () => {
    expect(normalizeMountPath('/Personal%20Drive')).toBe('/Personal Drive');
    expect(() => normalizeMountPath('photos')).toThrow('leading slash');
    expect(() => normalizeMountPath('/photos/nested')).toThrow('single segment');
    expect(() => normalizeMountPath('/photos%2Fnested')).toThrow('single segment');
    expect(() => normalizeMountPath('/photos%00')).toThrow('control');
  });

  it('rejects literal and decoded dot mount path segments', () => {
    expect(() => normalizeMountPath('/.')).toThrow('dot');
    expect(() => normalizeMountPath('/..')).toThrow('dot');
    expect(() => normalizeMountPath('/%2E')).toThrow('dot');
    expect(() => normalizeMountPath('/%2E%2E')).toThrow('dot');
  });

  it('rejects duplicate and reserved mount paths', async () => {
    await createMount(db(), { name: 'Photos', mountPath: '/photos', driverType: 's3', provider: 'cloudflare-r2' });
    await expect(
      createMount(db(), { name: 'Other', mountPath: '/photos', driverType: 's3', provider: 'custom' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(() => normalizeMountPath('/api')).toThrow('reserved');
  });

  it('creates, lists, updates, and gets mounts with normalized defaults', async () => {
    const first = await createMount(db(), {
      name: ' Photos ',
      mountPath: '/Photos',
      driverType: 's3',
      provider: 'cloudflare-r2',
      config: { bucket: 'photos' },
    });
    const second = await createMount(db(), {
      name: 'Archive',
      mountPath: '/archive',
      driverType: 'onedrive',
      provider: 'microsoft-onedrive',
      sortOrder: -1,
      enabled: false,
      isPublic: false,
      rootItemId: 'root-item',
    });

    expect(first).toMatchObject({
      name: 'Photos',
      mountPath: '/Photos',
      driverType: 's3',
      enabled: true,
      isPublic: false,
      sortOrder: 0,
      config: { bucket: 'photos' },
    });
    await expect(listMounts(db())).resolves.toMatchObject([second, first]);

    await expect(updateMount(db(), first.id, { name: 'Images', isPublic: false, sortOrder: 3 })).resolves.toMatchObject({
      id: first.id,
      name: 'Images',
      mountPath: '/Photos',
      isPublic: false,
      sortOrder: 3,
    });
    await expect(getMount(db(), first.id)).resolves.toMatchObject({ id: first.id, name: 'Images' });
    await expect(updateMount(db(), 'missing', { enabled: false })).resolves.toBeNull();
  });

  it('defaults an omitted publication setting to private without changing explicit values', async () => {
    const privateMount = await createMount(db(), {
      name: 'Private by default',
      mountPath: '/private-default',
      driverType: 's3',
      provider: 'cloudflare-r2',
    });
    const publicMount = await createMount(db(), {
      name: 'Explicit public',
      mountPath: '/explicit-public',
      driverType: 's3',
      provider: 'cloudflare-r2',
      isPublic: true,
    });

    expect(privateMount.isPublic).toBe(false);
    expect(publicMount.isPublic).toBe(true);
  });

  it('deletes mount configuration without touching any provider', async () => {
    const mount = await createMount(db(), {
      name: 'Backups',
      mountPath: '/backups',
      driverType: 's3',
      provider: 'backblaze-b2',
      config: { bucket: 'backups' },
    });

    await deleteMount(db(), mount.id);

    await expect(getMount(db(), mount.id)).resolves.toBeNull();
  });
});
