import { ApiError, jsonRequest, unwrap } from './client';
import type { CreatedShare, CreateShareInput, ShareView, UpdateShareInput } from '../types/shares';

export function createShare(input: CreateShareInput): Promise<CreatedShare> {
  return jsonRequest('/api/admin/shares', { method: 'POST', body: JSON.stringify(input) });
}

export async function listShares(): Promise<ShareView[]> {
  return unwrap<ShareView[]>(await fetch('/api/admin/shares', { credentials: 'same-origin' }));
}

export function updateShare(id: string, input: UpdateShareInput): Promise<ShareView> {
  return jsonRequest(`/api/admin/shares/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function deleteShare(id: string): Promise<void> {
  const response = await fetch(`/api/admin/shares/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try { payload = await response.json() as typeof payload; } catch { /* Empty error body. */ }
    throw new ApiError(response.status, payload.error?.code ?? `HTTP_${response.status}`, payload.error?.message ?? 'Request failed', payload.error?.details);
  }
}
