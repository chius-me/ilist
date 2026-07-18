import { jsonRequest, unwrap } from './client';
import type { DirectoryResponse, Entry } from '../types/entries';
import type { PublicShareMeta } from '../types/shares';

const base = (token: string) => `/s/${encodeURIComponent(token)}`;

export async function getPublicShare(token: string, signal?: AbortSignal): Promise<PublicShareMeta> {
  return unwrap<PublicShareMeta>(await fetch(`${base(token)}/api`, { signal, credentials: 'same-origin' }));
}

export function unlockPublicShare(token: string, password: string): Promise<Record<string, never>> {
  return jsonRequest(`${base(token)}/auth`, { method: 'POST', body: JSON.stringify({ password }) });
}

export async function listPublicShare(token: string, parent?: string, signal?: AbortSignal): Promise<DirectoryResponse> {
  const query = parent ? `?${new URLSearchParams({ parent })}` : '';
  return unwrap<DirectoryResponse>(await fetch(`${base(token)}/api/list${query}`, { signal, credentials: 'same-origin' }));
}

export function publicShareFileUrl(token: string, entry: Pick<Entry, 'id' | 'name'>, download = false): string {
  const url = `${base(token)}/file/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.name)}`;
  return download ? `${url}?download=1` : url;
}
