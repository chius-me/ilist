import { jsonRequest, unwrap } from './client';
import type { AdminUser } from '../types/entries';

export async function me(): Promise<AdminUser> {
  return unwrap<AdminUser>(await fetch('/api/admin/me', { credentials: 'same-origin' }));
}

export function login(username: string, password: string): Promise<AdminUser> {
  return jsonRequest('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export async function logout(): Promise<void> {
  await jsonRequest<Record<string, never>>('/api/admin/logout', { method: 'POST' });
}
