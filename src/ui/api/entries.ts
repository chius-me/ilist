import { jsonRequest, unwrap } from './client';
import type { BatchResult, DirectoryResponse, Entry, EntryPatch } from '../types/entries';

export interface ListDirectoryOptions {
  cursor?: string | null;
  limit?: number;
  refresh?: boolean;
}

export async function listDirectory(
  path: string,
  signal?: AbortSignal,
  nameFilter?: string,
  options: ListDirectoryOptions = {},
): Promise<DirectoryResponse> {
  const query = new URLSearchParams({ path });
  const needle = nameFilter?.trim();
  if (needle) query.set('q', needle);
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.refresh) query.set('refresh', '1');
  return unwrap<DirectoryResponse>(await fetch(`/api/fs/list?${query}`, { signal, credentials: 'same-origin' }));
}

export async function getEntry(id: string, signal?: AbortSignal): Promise<Entry> {
  return unwrap<Entry>(await fetch(`/api/fs/entries/${encodeURIComponent(id)}`, { signal, credentials: 'same-origin' }));
}

export function createFolder(parentId: string, name: string): Promise<Entry> {
  return jsonRequest('/api/admin/folders', { method: 'POST', body: JSON.stringify({ parentId, name }) });
}

export function patchEntry(id: string, patch: EntryPatch): Promise<Entry> {
  return jsonRequest(`/api/admin/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function moveEntries(ids: string[], destinationId: string): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/move', { method: 'POST', body: JSON.stringify({ ids, destinationId }) });
}

export function copyEntries(ids: string[], destinationId: string): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/copy', { method: 'POST', body: JSON.stringify({ ids, destinationId }) });
}

export function deleteEntries(ids: string[]): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/delete', { method: 'POST', body: JSON.stringify({ ids }) });
}

export function setVisibility(ids: string[], isPublic: boolean): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/visibility', { method: 'POST', body: JSON.stringify({ ids, isPublic }) });
}

export { fileUrl } from '../lib/file-urls';

export function childPath(parentPath: string, name: string): string {
  const base = parentPath === '/' ? '' : parentPath.replace(/\/$/, '');
  return `${base}/${encodeURIComponent(name)}`;
}

export function entryPath(parentPath: string, entry: Pick<Entry, 'name' | 'mountPath'>): string {
  if (parentPath === '/' && entry.mountPath) {
    return `/${encodeURIComponent(entry.mountPath.slice(1))}`;
  }
  return childPath(parentPath, entry.name);
}
