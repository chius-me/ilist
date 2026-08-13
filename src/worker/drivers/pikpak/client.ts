import { getCredentials, patchCredentials, providerSecrets } from '../../credentials';
import { HttpError } from '../../http';
import type { Env } from '../../types';
import {
  PIKPAK_CLIENT_ID, PIKPAK_CLIENT_VERSION, PIKPAK_USER_AGENT, requestPikPakCaptcha,
} from './auth';
import { getPikPakSession } from './tokens';
import type { PikPakFile, PikPakFileList, PikPakNewFile } from './types';

const DRIVE_ORIGIN = 'https://api-drive.mypikpak.com';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerError(status: number, payload: unknown): HttpError {
  const reason = isRecord(payload) && typeof payload.error === 'string' ? payload.error : '';
  if (status === 401) return new HttpError(401, 'PIKPAK_AUTH_EXPIRED', 'PikPak authentication expired');
  if (status === 403) return new HttpError(403, 'PIKPAK_ACCESS_DENIED', 'PikPak access was denied');
  if (status === 404) return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'PikPak item was not found');
  if (status === 409 || reason.includes('duplicated')) return new HttpError(409, 'STORAGE_CONFLICT', 'A PikPak item with this name already exists');
  if (status === 429) return new HttpError(503, 'PIKPAK_RATE_LIMITED', 'PikPak is temporarily rate limited');
  return new HttpError(502, 'PIKPAK_UPSTREAM_FAILED', 'PikPak request failed');
}

function isInvalidCaptcha(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const reason = typeof payload.error === 'string'
    ? payload.error
    : typeof payload.reason === 'string' ? payload.reason : '';
  return reason === 'captcha_invalid';
}

async function parsedResponse(response: Response): Promise<unknown> {
  try { return await response.clone().json(); } catch { return null; }
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
    url.searchParams.set('thumbnail_size', 'SIZE_MEDIUM');
    url.searchParams.set('limit', '500');
    url.searchParams.set('with_audit', 'true');
    if (parentId !== 'root') url.searchParams.set('parent_id', parentId);
    // PikPak distinguishes an explicit empty first-page token from an omitted parameter.
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

  async createFolder(parentId: string, name: string): Promise<PikPakFile> {
    const result = await this.requestJson<PikPakNewFile>(new URL(`${DRIVE_ORIGIN}/drive/v1/files`), {
      method: 'POST', body: JSON.stringify({ kind: 'drive#folder', name, parent_id: parentId === 'root' ? '' : parentId, folder_type: 'NORMAL' }),
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
    const link = item.links?.['application/octet-stream']?.url ?? item.web_content_link;
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

  private async captcha(action: string, userId?: string): Promise<string> {
    const credentials = await getCredentials(this.env, this.mountId);
    const provider = providerSecrets(credentials);
    if (typeof provider.captchaToken === 'string' && typeof provider.captchaExpiresAt === 'number' && provider.captchaExpiresAt > Date.now() + 10_000) {
      return provider.captchaToken;
    }
    const session = await getPikPakSession(this.env, this.mountId, false, this.fetcher);
    const previousToken = typeof provider.captchaToken === 'string' ? provider.captchaToken : '';
    const captcha = await requestPikPakCaptcha(
      action,
      session.deviceId,
      { userId: userId ?? session.userId },
      this.fetcher,
      previousToken,
    );
    await patchCredentials(this.env, this.mountId, { provider: { captchaToken: captcha.token, captchaExpiresAt: captcha.expiresAt } });
    return captcha.token;
  }

  private async requestJson<T>(
    url: URL,
    init: RequestInit,
    retry: { auth?: boolean; captcha?: boolean } = {},
  ): Promise<T> {
    const session = await getPikPakSession(this.env, this.mountId, retry.auth === true, this.fetcher);
    const action = `${(init.method ?? 'GET').toUpperCase()}:${url.pathname}`;
    const headers = new Headers(init.headers);
    headers.set('authorization', `${session.tokenType} ${session.accessToken}`);
    headers.set('content-type', 'application/json');
    headers.set('user-agent', PIKPAK_USER_AGENT);
    headers.set('referer', 'https://mypikpak.com/');
    headers.set('x-client-id', PIKPAK_CLIENT_ID);
    headers.set('x-client-version', PIKPAK_CLIENT_VERSION);
    headers.set('x-device-id', session.deviceId);
    headers.set('x-captcha-token', await this.captcha(action, session.userId));
    let response: Response;
    try { response = await this.fetcher(url, { ...init, headers }); }
    catch { throw new HttpError(502, 'PIKPAK_UPSTREAM_FAILED', 'PikPak request failed'); }
    if (response.status === 401 && !retry.auth) return this.requestJson<T>(url, init, { ...retry, auth: true });
    if (!response.ok && !retry.captcha && isInvalidCaptcha(await parsedResponse(response))) {
      await patchCredentials(this.env, this.mountId, {
        provider: { captchaToken: null, captchaExpiresAt: null },
      });
      return this.requestJson<T>(url, init, { ...retry, captcha: true });
    }
    return responseJson<T>(response);
  }
}
