import { jsonRequest, unwrap } from './client';
import type { BatchResult, DirectoryResponse, Entry, EntryPatch } from '../types/entries';

export async function listDirectory(path: string, signal?: AbortSignal): Promise<DirectoryResponse> {
  const query = new URLSearchParams({ path });
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

export function deleteEntries(ids: string[]): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/delete', { method: 'POST', body: JSON.stringify({ ids }) });
}

export function setVisibility(ids: string[], isPublic: boolean): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/visibility', { method: 'POST', body: JSON.stringify({ ids, isPublic }) });
}

export function fileUrl(entry: Pick<Entry, 'id' | 'name'>, download = false, exportFormat?: string): string {
  const url = `/file/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.name)}`;
  const query = new URLSearchParams();
  if (download) query.set('download', '1');
  if (exportFormat) query.set('export', exportFormat);
  const suffix = query.toString();
  return suffix ? `${url}?${suffix}` : url;
}

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
