import { jsonRequest, unwrap } from './client';
import type { Mount, MountInput } from '../types/mounts';

export function listMounts(): Promise<Mount[]> {
  return jsonRequest('/api/admin/mounts');
}

export function createMount(input: MountInput): Promise<Mount> {
  return jsonRequest('/api/admin/mounts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateMount(id: string, input: Partial<MountInput>): Promise<Mount> {
  return jsonRequest(`/api/admin/mounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function removeMount(id: string): Promise<void> {
  const response = await fetch(`/api/admin/mounts/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!response.ok) await unwrap(response);
}

export function testMount(id: string): Promise<unknown> {
  return jsonRequest(`/api/admin/mounts/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' });
}

export function disconnectMount(id: string): Promise<Mount> {
  return jsonRequest(`/api/admin/mounts/${encodeURIComponent(id)}/disconnect`, { method: 'POST', body: '{}' });
}

export function oneDriveConnectUrl(id: string): string {
  return `/api/admin/oauth/onedrive/start?mountId=${encodeURIComponent(id)}`;
}

export function googleDriveConnectUrl(id: string): string {
  return `/api/admin/oauth/google/start?mountId=${encodeURIComponent(id)}`;
}
