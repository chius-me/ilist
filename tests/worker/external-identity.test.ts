import { describe, expect, it, vi } from 'vitest';
import type { StorageDriver, StorageItem } from '../../src/worker/drivers/types';
import { externalEntry } from '../../src/worker/external-entries';
import { decodeExternalId, encodeExternalId } from '../../src/worker/external-identity';
import { fileUrl } from '../../src/ui/api/entries';
import { publicShareFileUrl } from '../../src/ui/api/public-shares';
import type { Mount } from '../../src/worker/types';

describe('external entry identity', () => {
  it('round-trips provider IDs without exposing them as the public identity', () => {
    const id = encodeExternalId('mount-one', '01ABC/中文 item');

    expect(id).not.toContain('01ABC');
    expect(decodeExternalId(id)).toEqual({ mountId: 'mount-one', itemId: '01ABC/中文 item' });
  });

  it('scopes identical provider IDs to their mounts', () => {
    expect(encodeExternalId('mount-one', 'same-id')).not.toBe(encodeExternalId('mount-two', 'same-id'));
  });

  it.each(['', 'native-id', 'ext_bad', 'ext_eyJ2IjoyfQ'])('rejects malformed identities: %s', (id) => {
    expect(decodeExternalId(id)).toBeNull();
  });

  it('maps provider-neutral export options and includes explicit formats in file URLs', () => {
    const exportOptions = [
      { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' },
    ];
    const item: StorageItem = {
      id: 'workspace-doc',
      parentId: 'root',
      name: 'Document',
      kind: 'file',
      size: null,
      contentType: 'application/vnd.google-apps.document',
      modifiedAt: null,
      etag: null,
      exportOptions,
    };
    const mount: Mount = {
      id: 'google-one',
      name: 'Google Drive',
      mountPath: '/google',
      driverType: 's3',
      provider: 'google',
      enabled: true,
      isPublic: true,
      sortOrder: 0,
      rootItemId: null,
      config: {},
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    };
    const driver: StorageDriver = {
      rootId: 'root',
      capabilities: new Set(['download']),
      list: vi.fn(),
      stat: vi.fn(),
      getDownload: vi.fn(),
      createFolder: vi.fn(),
      upload: vi.fn(),
      rename: vi.fn(),
      move: vi.fn(),
      remove: vi.fn(),
    };

    const entry = externalEntry(item, mount, driver, false);

    expect(entry.exportOptions).toEqual(exportOptions);
    expect(entry.exportOptions).not.toBe(exportOptions);
    expect(fileUrl(entry, true, 'pdf')).toMatch(/\?download=1&export=pdf$/);
    expect(publicShareFileUrl('share token', entry, false, 'docx')).toMatch(/\?export=docx$/);
  });
});
