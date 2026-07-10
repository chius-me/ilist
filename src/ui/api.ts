import type { AdminUser, ApiEnvelope, FileEntry, TreeResponse } from './types';

async function unwrap<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || `Request failed with ${response.status}`);
  }
  return payload.data;
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function fileUrl(key: string): string {
  return `/file/${encodeKey(key)}`;
}

export async function getPublicTree(prefix: string): Promise<TreeResponse> {
  const params = new URLSearchParams({ prefix });
  return unwrap<TreeResponse>(await fetch(`/api/public/tree?${params}`));
}

export async function getAdminTree(prefix: string): Promise<TreeResponse> {
  const params = new URLSearchParams({ prefix });
  return unwrap<TreeResponse>(await fetch(`/api/admin/objects?${params}`, { credentials: 'same-origin' }));
}

export async function me(): Promise<AdminUser> {
  return unwrap<AdminUser>(await fetch('/api/admin/me', { credentials: 'same-origin' }));
}

export async function login(username: string, password: string): Promise<AdminUser> {
  return unwrap<AdminUser>(
    await fetch('/api/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  );
}

export async function logout(): Promise<void> {
  await unwrap(await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }));
}

export async function uploadObject(key: string, file: File): Promise<FileEntry> {
  return unwrap<FileEntry>(
    await fetch(`/api/admin/objects/${encodeKey(key)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'content-type': file.type || 'application/octet-stream',
      },
      body: file,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  const response = await fetch(`/api/admin/objects/${encodeKey(key)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok && response.status !== 204) {
    await unwrap(response);
  }
}

export async function patchObject(
  key: string,
  patch: { name?: string; description?: string; isPublic?: boolean; sortOrder?: number },
): Promise<FileEntry> {
  return unwrap<FileEntry>(
    await fetch(`/api/admin/objects/${encodeKey(key)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}
