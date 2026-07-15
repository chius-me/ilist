import { describe, expect, it } from 'vitest';
import { decodeExternalId, encodeExternalId } from '../../src/worker/external-identity';

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
});
