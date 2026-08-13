import { HttpError } from '../../http';
import type { Env } from '../../types';
import { getPikPakSession } from './tokens';
import type { PikPakFile, PikPakFileList, PikPakNewFile } from './types';

const DRIVE_ORIGIN = 'https://api-drive.mypikpak.net';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeProviderDetails(status: number, payload: unknown): {
  upstreamStatus: number; upstreamReason?: string; upstreamCode?: number;
} {
  const details: { upstreamStatus: number; upstreamReason?: string; upstreamCode?: number } = { upstreamStatus: status };
  if (!isRecord(payload)) return details;
  if (typeof payload.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(payload.error)) {
    details.upstreamReason = payload.error;
  }
  if (typeof payload.error_code === 'number' && Number.isSafeInteger(payload.error_code)) {
    details.upstreamCode = payload.error_code;
  }
  return details;
}

function providerError(status: number, payload: unknown): HttpError {
  const details = safeProviderDetails(status, payload);
  const reason = details.upstreamReason ?? '';
  if (status === 401) return new HttpError(401, 'PIKPAK_AUTH_EXPIRED', 'PikPak authentication expired', details);
  if (status === 403) return new HttpError(403, 'PIKPAK_ACCESS_DENIED', 'PikPak access was denied', details);
  if (status === 404) return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'PikPak item was not found', details);
  if (status === 409 || reason.includes('duplicated')) return new HttpError(409, 'STORAGE_CONFLICT', 'A PikPak item with this name already exists', details);
  if (status === 429) return new HttpError(503, 'PIKPAK_RATE_LIMITED', 'PikPak is temporarily rate limited', details);
  return new HttpError(502, 'PIKPAK_UPSTREAM_FAILED', 'PikPak request failed', details);
}

async function responseJson<T>(response: Response): Promise<T> {
  let value: unknown;
  try { value = await response.json(); } catch { value = null; }
  if (!response.ok) throw providerError(response.status, value);
  if (!isRecord(value)) throw new HttpError(502, 'PIKPAK_UPSTREAM_INVALID', 'PikPak response was invalid');
  return value as T;
}

export class PikPakClient {
  constructor(
    private readonly env: Env,
    private readonly mountId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async list(parentId: string, cursor?: string): Promise<PikPakFileList> {
    const url = new URL(`${DRIVE_ORIGIN}/drive/v1/files`);
    url.searchParams.set('parent_id', parentId === 'root' ? '' : parentId);
    url.searchParams.set('thumbnail_size', 'SIZE_MEDIUM');
    url.searchParams.set('with_audit', 'false');
    url.searchParams.set('page_token', cursor ?? '');
    url.searchParams.set('filters', JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } }));
    return this.requestJson<PikPakFileList>(url, { method: 'GET' });
  }

  stat(itemId: string): Promise<PikPakFile> {
    if (itemId === 'root') {
      return Promise.resolve({ id: 'root', name: 'PikPak', kind: 'drive#folder', parent_id: '' });
    }
    return this.requestJson<PikPakFile>(new URL(`${DRIVE_ORIGIN}/drive/v1/files/${encodeURIComponent(itemId)}`), { method: 'GET' });
  }

  downloadInfo(itemId: string): Promise<PikPakFile> {
    const url = new URL(`${DRIVE_ORIGIN}/drive/v1/files/${encodeURIComponent(itemId)}`);
    url.searchParams.set('_magic', '2021');
    url.searchParams.set('usage', 'FETCH');
    url.searchParams.set('thumbnail_size', 'SIZE_LARGE');
    return this.requestJson<PikPakFile>(url, { method: 'GET' });
  }

  async createFolder(parentId: string, name: string): Promise<PikPakFile> {
    const result = await this.requestJson<PikPakNewFile>(new URL(`${DRIVE_ORIGIN}/drive/v1/files`), {
      method: 'POST', body: JSON.stringify({ kind: 'drive#folder', name, parent_id: parentId === 'root' ? '' : parentId }),
    });
    if (!result.file) throw new HttpError(502, 'PIKPAK_UPSTREAM_INVALID', 'PikPak response was invalid');
    return result.file;
  }

  rename(itemId: string, name: string): Promise<PikPakFile> {
    return this.requestJson<PikPakFile>(new URL(`${DRIVE_ORIGIN}/drive/v1/files/${encodeURIComponent(itemId)}`), {
      method: 'PATCH', body: JSON.stringify({ name }),
    });
  }

  async move(itemId: string, destinationId: string): Promise<void> {
    await this.requestJson<Record<string, unknown>>(new URL(`${DRIVE_ORIGIN}/drive/v1/files:batchMove`), {
      method: 'POST', body: JSON.stringify({ ids: [itemId], to: { parent_id: destinationId === 'root' ? '' : destinationId } }),
    });
  }

  async remove(itemId: string, useTrash: boolean): Promise<void> {
    await this.requestJson<Record<string, unknown>>(new URL(`${DRIVE_ORIGIN}/drive/v1/files:${useTrash ? 'batchTrash' : 'batchDelete'}`), {
      method: 'POST', body: JSON.stringify({ ids: [itemId] }),
    });
  }

  async download(item: PikPakFile, request: Request): Promise<Response> {
    if ((typeof item.size === 'number' && item.size === 0) || item.size === '0') return new Response(new Uint8Array(), { status: 200 });
    const link = item.web_content_link ?? item.links?.['application/octet-stream']?.url ?? item.medias?.[0]?.link?.url;
    if (!link) throw new HttpError(502, 'PIKPAK_DOWNLOAD_UNAVAILABLE', 'PikPak original download is unavailable');
    let url: URL;
    try { url = new URL(link); } catch { throw new HttpError(502, 'PIKPAK_DOWNLOAD_UNAVAILABLE', 'PikPak original download is unavailable'); }
    if (url.protocol !== 'https:') throw new HttpError(502, 'PIKPAK_DOWNLOAD_UNAVAILABLE', 'PikPak original download is unavailable');
    const headers = new Headers();
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    const response = await this.fetcher(url, { headers, redirect: 'follow' });
    if (!response.ok && response.status !== 206) throw new HttpError(502, 'PIKPAK_DOWNLOAD_FAILED', 'PikPak download failed');
    return response;
  }

  private async requestJson<T>(
    url: URL,
    init: RequestInit,
    forceRefresh = false,
  ): Promise<T> {
    const session = await getPikPakSession(this.env, this.mountId, forceRefresh, this.fetcher);
    const headers = new Headers(init.headers);
    headers.set('authorization', `${session.tokenType} ${session.accessToken}`);
    headers.set('content-type', 'application/json');
    let response: Response;
    try { response = await this.fetcher(url, { ...init, headers }); }
    catch { throw new HttpError(502, 'PIKPAK_UPSTREAM_FAILED', 'PikPak request failed'); }
    if (response.status === 401 && !forceRefresh) return this.requestJson<T>(url, init, true);
    return responseJson<T>(response);
  }
}
