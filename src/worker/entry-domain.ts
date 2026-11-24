import { HttpError } from './http';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

export function validateEntryName(value: string): string {
  const byteLength = encoder.encode(value).byteLength;
  const invalid =
    !value.trim()
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || CONTROL_CHARACTERS.test(value)
    || byteLength > 255;
  if (invalid) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Invalid entry name', { name: value });
  }
  return value;
}

export function matchesNameFilter(name: string, query: string | null | undefined): boolean {
  const needle = query?.trim().toLocaleLowerCase() ?? '';
  if (!needle) return true;
  return name.toLocaleLowerCase().includes(needle);
}
