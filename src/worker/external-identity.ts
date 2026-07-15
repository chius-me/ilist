const PREFIX = 'ext_';

export interface ExternalIdentity {
  mountId: string;
  itemId: string;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function encodeExternalId(mountId: string, itemId: string): string {
  return `${PREFIX}${toBase64Url(JSON.stringify({ v: 1, m: mountId, i: itemId }))}`;
}

export function decodeExternalId(id: string): ExternalIdentity | null {
  if (!id.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(fromBase64Url(id.slice(PREFIX.length))) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.m !== 'string' || !value.m || typeof value.i !== 'string' || !value.i) {
      return null;
    }
    return { mountId: value.m, itemId: value.i };
  } catch {
    return null;
  }
}
