import { HttpError } from './http';

const RESERVED_ROOT_NAMES = new Set(['api', 'file', 'admin']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateEntryName(value: string, topLevel = false): string {
  const name = value;
  const byteLength = new TextEncoder().encode(name).byteLength;
  const invalid =
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    CONTROL_CHARACTERS.test(name) ||
    byteLength > 255 ||
    (topLevel && RESERVED_ROOT_NAMES.has(name));
  if (invalid) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Invalid entry name', { name: value });
  }
  return name;
}

export function normalizeVirtualPath(pathname: string): { path: string; segments: string[] } {
  const rawSegments = pathname.replace(/\\/g, '/').split('/').filter(Boolean);
  let segments: string[];
  try {
    segments = rawSegments.map((segment, index) => validateEntryName(decodeURIComponent(segment), index === 0));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_PATH', 'Invalid encoded path');
  }
  return { path: segments.length ? `/${segments.join('/')}` : '/', segments };
}

export function encodeVirtualPath(segments: string[]): string {
  return segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : '/';
}

export function storageKeyForEntry(id: string, attemptOwner?: string): string {
  return attemptOwner ? `blobs/${id}/${attemptOwner}` : `blobs/${id}`;
}
