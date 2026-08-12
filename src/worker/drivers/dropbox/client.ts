import { HttpError } from '../../http';
import type { Env } from '../../types';
import { getDropboxAccessToken, refreshDropboxAccessToken } from './tokens';
import type {
  DropboxListPayload,
  DropboxMetadata,
  DropboxRelocationResult,
  DropboxUploadSessionStartResult,
} from './types';

const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';
const RESPONSE_HEADERS = [
  'accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range',
  'content-type', 'etag', 'last-modified',
];

type AccessTokenProvider = (env: Env, mountId: string) => Promise<string>;
type AccessTokenRefresher = (
  env: Env,
  mountId: string,
  rejectedAccessToken: string,
  fetcher: typeof fetch,
) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRange(value: string | null): string | null {
  if (value === null) return null;
  if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(value.trim())) {
    throw new HttpError(400, 'INVALID_RANGE', 'Range header is invalid');
  }
  return value.trim();
}

function retryAfter(value: string | null): { retryAfter: number } | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? { retryAfter: seconds } : undefined;
}

function safeResponse(response: Response): Response {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function dropboxApiArgument(value: Record<string, unknown>): string {
  // Fetch header values are byte strings. Dropbox accepts JSON escape sequences,
  // so escape non-ASCII UTF-16 code units while preserving valid JSON semantics.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

async function errorSummary(response: Response): Promise<string> {
  try {
    const payload = await response.clone().json<unknown>();
    if (isRecord(payload) && typeof payload.error_summary === 'string') return payload.error_summary.toLowerCase();
  } catch {
    // Provider failures are normalized even when the response is not JSON.
  }
  return '';
}

async function dropboxError(response: Response): Promise<HttpError> {
  const summary = await errorSummary(response);
  const details = retryAfter(response.headers.get('retry-after'));
  if (response.status === 401) return new HttpError(401, 'DROPBOX_AUTH_FAILED', 'Dropbox authentication failed');
  if (response.status === 403) return new HttpError(403, 'DROPBOX_ACCESS_DENIED', 'Dropbox access was denied');
  if (response.status === 409 && /incorrect_offset/.test(summary)) {
    return new HttpError(409, 'DROPBOX_UPLOAD_SESSION_INVALID_RANGE', 'Dropbox upload part range is invalid');
  }
  if (response.status === 409 && summary.includes('upload_session') && /lookup_failed|not_found/.test(summary)) {
    return new HttpError(410, 'DROPBOX_UPLOAD_SESSION_EXPIRED', 'Dropbox upload session has expired');
  }
  if (response.status === 409 && /not_found|not_file|not_folder/.test(summary)) {
    return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Dropbox item was not found');
  }
  if (response.status === 409 && /conflict|duplicated_or_nested_paths/.test(summary)) {
    return new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name');
  }
  if (response.status === 429) {
    return new HttpError(503, 'DROPBOX_RATE_LIMITED', 'Dropbox is temporarily rate limited', details);
  }
  if (response.status === 507 || /insufficient_space/.test(summary)) {
    return new HttpError(507, 'DROPBOX_INSUFFICIENT_SPACE', 'Dropbox has insufficient storage space');
  }
  return new HttpError(502, 'DROPBOX_UPSTREAM_FAILED', 'Dropbox request failed', details);
}

function assertMetadata(value: unknown): DropboxMetadata {
  if (
    !isRecord(value)
    || (value['.tag'] !== 'file' && value['.tag'] !== 'folder')
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.name !== 'string'
  ) throw new HttpError(502, 'DROPBOX_UPSTREAM_INVALID', 'Dropbox response was invalid');
  return value as unknown as DropboxMetadata;
}

export class DropboxClient {
  constructor(
    private readonly env: Env,
    private readonly mountId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tokenProvider: AccessTokenProvider = getDropboxAccessToken,
    private readonly tokenRefresher: AccessTokenRefresher = refreshDropboxAccessToken,
  ) {}

  async list(path: string, cursor?: string): Promise<{ items: DropboxMetadata[]; nextCursor: string | null }> {
    const payload = cursor
      ? await this.rpc<DropboxListPayload>('files/list_folder/continue', { cursor })
      : await this.rpc<DropboxListPayload>('files/list_folder', {
        path,
        recursive: false,
        include_deleted: false,
        include_has_explicit_shared_members: false,
        limit: 2000,
      });
    if (!isRecord(payload) || !Array.isArray(payload.entries) || typeof payload.cursor !== 'string' || typeof payload.has_more !== 'boolean') {
      throw new HttpError(502, 'DROPBOX_UPSTREAM_INVALID', 'Dropbox response was invalid');
    }
    return {
      items: payload.entries.filter((item) => item?.['.tag'] !== 'deleted').map(assertMetadata),
      nextCursor: payload.has_more ? payload.cursor : null,
    };
  }

  async stat(path: string): Promise<DropboxMetadata> {
    return assertMetadata(await this.rpc('files/get_metadata', {
      path,
      include_deleted: false,
      include_has_explicit_shared_members: false,
    }));
  }

  async download(path: string, range: string | null = null): Promise<Response> {
    const headers = new Headers();
    const checkedRange = validRange(range);
    if (checkedRange) headers.set('range', checkedRange);
    return safeResponse(await this.content('files/download', { path }, { headers }));
  }

  async exportFile(path: string, format: string): Promise<Response> {
    return safeResponse(await this.content('files/export', { path, export_format: format }));
  }

  async createFolder(path: string): Promise<DropboxMetadata> {
    const result = await this.rpc<{ metadata?: unknown }>('files/create_folder_v2', { path, autorename: false });
    return assertMetadata(result.metadata);
  }

  async upload(path: string, body: ReadableStream): Promise<DropboxMetadata> {
    const response = await this.content('files/upload', {
      path,
      mode: 'add',
      autorename: false,
      mute: false,
      strict_conflict: true,
    }, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: body as BodyInit,
    });
    return assertMetadata(await this.responseJson(response));
  }

  async move(fromPath: string, toPath: string): Promise<DropboxMetadata> {
    const result = await this.rpc<DropboxRelocationResult>('files/move_v2', {
      from_path: fromPath,
      to_path: toPath,
      autorename: false,
      allow_ownership_transfer: false,
    });
    return assertMetadata(result.metadata);
  }

  async copy(fromPath: string, toPath: string): Promise<DropboxMetadata> {
    const result = await this.rpc<DropboxRelocationResult>('files/copy_v2', {
      from_path: fromPath,
      to_path: toPath,
      autorename: false,
      allow_ownership_transfer: false,
    });
    return assertMetadata(result.metadata);
  }

  async remove(path: string): Promise<void> {
    await this.rpc('files/delete_v2', { path });
  }

  async createUploadSession(): Promise<string> {
    const response = await this.content('files/upload_session/start', { close: false }, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });
    const result = await this.responseJson(response) as DropboxUploadSessionStartResult;
    if (!isRecord(result) || typeof result.session_id !== 'string' || !result.session_id) {
      throw new HttpError(502, 'DROPBOX_UPLOAD_SESSION_INVALID', 'Dropbox upload session response was invalid');
    }
    return result.session_id;
  }

  async appendUploadSession(
    sessionId: string,
    offset: number,
    body: ReadableStream | Uint8Array,
    close: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.content('files/upload_session/append_v2', {
      cursor: { session_id: sessionId, offset },
      close,
    }, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: body instanceof Uint8Array ? body : body as BodyInit,
      signal,
    });
  }

  async finishUploadSession(sessionId: string, offset: number, path: string): Promise<DropboxMetadata> {
    const response = await this.content('files/upload_session/finish', {
      cursor: { session_id: sessionId, offset },
      commit: {
        path,
        mode: 'add',
        autorename: false,
        mute: false,
        strict_conflict: true,
      },
    }, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });
    return assertMetadata(await this.responseJson(response));
  }

  closeUploadSession(sessionId: string, offset: number): Promise<void> {
    return this.appendUploadSession(sessionId, offset, new Uint8Array(0), true);
  }

  private rpc<T>(route: string, body: Record<string, unknown>): Promise<T> {
    return this.requestJson<T>(`${API_BASE}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private content(route: string, argument: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('dropbox-api-arg', dropboxApiArgument(argument));
    return this.request(`${CONTENT_BASE}/${route}`, { ...init, method: init.method ?? 'POST', headers });
  }

  private async responseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, 'DROPBOX_UPSTREAM_INVALID', 'Dropbox response was invalid');
    }
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    return await this.responseJson(await this.request(url, init)) as T;
  }

  private async request(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const accessToken = await this.tokenProvider(this.env, this.mountId);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, url, { ...init, headers });
    } catch {
      throw new HttpError(502, 'DROPBOX_UPSTREAM_FAILED', 'Dropbox request failed');
    }
    if (response.status === 401 && !retried) {
      await this.tokenRefresher(this.env, this.mountId, accessToken, this.fetcher);
      return this.request(url, init, true);
    }
    if (!response.ok) throw await dropboxError(response);
    return response;
  }
}
