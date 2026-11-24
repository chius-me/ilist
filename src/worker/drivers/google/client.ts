import { HttpError } from '../../http';
import {
  assertValidRange,
  DEFAULT_METADATA_TIMEOUT_MS,
  DEFAULT_TRANSFER_TIMEOUT_MS,
  fetchWithRetry,
  retryAfterDetails,
  safeUpstreamResponse,
} from '../../shared/http-client';
import type { Env } from '../../types';
import { GOOGLE_FOLDER_MIME_TYPE } from './items';
import { getGoogleAccessToken, refreshGoogleAccessToken } from './tokens';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed';
const RESPONSE_HEADERS = [
  'accept-ranges', 'cache-control', 'content-length', 'content-range', 'content-type',
  'etag', 'last-modified',
];

export interface GoogleFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface GoogleListResult {
  items: GoogleFile[];
  nextCursor: string | null;
}

export interface GoogleUploadSession {
  sessionUrl: string;
  expiresAt: number;
}

export type GoogleUploadPartResult =
  | { completed: false; nextOffset: number }
  | { completed: true; item: GoogleFile };

interface GoogleListPayload {
  files?: GoogleFile[];
  nextPageToken?: string;
}

type AccessTokenProvider = (env: Env, mountId: string) => Promise<string>;
type AccessTokenRefresher = (
  env: Env,
  mountId: string,
  rejectedAccessToken: string,
  fetcher: typeof fetch,
) => Promise<string>;

function escapeQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function validatedSessionUrl(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'www.googleapis.com'
      || url.port
      || url.username
      || url.password
      || !url.pathname.startsWith('/upload/drive/')
    ) throw new Error('Invalid Google Drive upload URL');
    return url.toString();
  } catch {
    throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
  }
}

function uploadSessionError(response: Response): HttpError {
  const details = retryAfterDetails(response.headers.get('retry-after'));
  if (response.status === 404 || response.status === 410) {
    return new HttpError(410, 'GOOGLE_UPLOAD_SESSION_EXPIRED', 'Google upload session has expired');
  }
  if (response.status === 416) {
    return new HttpError(409, 'GOOGLE_UPLOAD_SESSION_INVALID_RANGE', 'Google upload part range is invalid');
  }
  if (response.status === 429) {
    return new HttpError(503, 'GOOGLE_UPLOAD_SESSION_RATE_LIMITED', 'Google upload session is temporarily rate limited', details);
  }
  return new HttpError(502, 'GOOGLE_UPLOAD_SESSION_FAILED', 'Google upload session request failed', details);
}

/**
 * Pull-based multipart body stream so upstream write backpressure governs source reads.
 */
function multipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  contentType: string,
  body: ReadableStream,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`
    + `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  let phase: 'prefix' | 'body' | 'done' = 'prefix';
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled || phase === 'done') return;
      if (phase === 'prefix') {
        phase = 'body';
        controller.enqueue(prefix);
        return;
      }
      reader ??= body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      try {
        const result = await reader.read();
        if (cancelled) return;
        if (result.done) {
          phase = 'done';
          reader.releaseLock();
          reader = null;
          controller.enqueue(suffix);
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (reader) {
          try { reader.releaseLock(); } catch { /* Ignore release error on failed stream. */ }
          reader = null;
        }
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      phase = 'done';
      if (reader) {
        const active = reader;
        reader = null;
        try {
          return await active.cancel(reason);
        } finally {
          try { active.releaseLock(); } catch { /* Ignore release error on cancel. */ }
        }
      }
      return body.cancel(reason);
    },
  });
}

async function googleError(response: Response): Promise<HttpError> {
  let reason: string | undefined;
  try {
    const payload = await response.clone().json<{
      error?: { errors?: Array<{ reason?: string }> };
    }>();
    reason = payload.error?.errors?.find((item) => typeof item.reason === 'string')?.reason;
  } catch {
    // Upstream errors are normalized even when no JSON body is present.
  }
  if (response.status === 401) return new HttpError(401, 'GOOGLE_AUTH_FAILED', 'Google Drive authentication failed');
  if (response.status === 403 && reason && /quota|rateLimit/i.test(reason)) {
    return new HttpError(503, 'GOOGLE_QUOTA_EXCEEDED', 'Google Drive quota is temporarily unavailable');
  }
  if (response.status === 403) return new HttpError(403, 'GOOGLE_ACCESS_DENIED', 'Google Drive access was denied');
  if (response.status === 404) return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'Google Drive item was not found');
  if (response.status === 409) return new HttpError(409, 'STORAGE_CONFLICT', 'Google Drive item conflicts with an existing item');
  if (response.status === 429) return new HttpError(503, 'GOOGLE_RATE_LIMITED', 'Google Drive is temporarily rate limited');
  return new HttpError(502, 'GOOGLE_UPSTREAM_FAILED', 'Google Drive request failed');
}

export class GoogleDriveClient {
  private cachedToken: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly mountId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tokenProvider: AccessTokenProvider = getGoogleAccessToken,
    private readonly tokenRefresher: AccessTokenRefresher = refreshGoogleAccessToken,
  ) {}

  async list(parentId: string, cursor?: string, limit?: number): Promise<GoogleListResult> {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set('q', `'${escapeQueryLiteral(parentId)}' in parents and trashed=false`);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    const pageSize = limit === undefined ? 1000 : Math.min(Math.max(1, limit), 1000);
    url.searchParams.set('pageSize', String(pageSize));
    if (cursor) url.searchParams.set('pageToken', cursor);
    const payload = await this.requestJson<GoogleListPayload>(url.toString());
    if (!Array.isArray(payload.files)) throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    if (payload.nextPageToken !== undefined && typeof payload.nextPageToken !== 'string') {
      throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    }
    return { items: payload.files, nextCursor: payload.nextPageToken ?? null };
  }

  async findChildByName(parentId: string, name: string, folderOnly = false): Promise<GoogleFile | null> {
    const url = new URL(`${DRIVE_BASE}/files`);
    const folderFilter = folderOnly ? ` and mimeType='${GOOGLE_FOLDER_MIME_TYPE}'` : '';
    url.searchParams.set(
      'q',
      `'${escapeQueryLiteral(parentId)}' in parents and name='${escapeQueryLiteral(name)}'${folderFilter} and trashed=false`,
    );
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', `files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', '1');
    const payload = await this.requestJson<GoogleListPayload>(url.toString());
    if (!Array.isArray(payload.files)) throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    return payload.files[0] ?? null;
  }

  async existsByName(parentId: string, name: string): Promise<boolean> {
    return (await this.findChildByName(parentId, name, false)) !== null;
  }

  stat(itemId: string): Promise<GoogleFile> {
    const url = this.fileUrl(itemId);
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(url.toString());
  }

  async download(itemId: string, range: string | null = null): Promise<Response> {
    const url = this.fileUrl(itemId);
    url.searchParams.set('alt', 'media');
    const validatedRange = assertValidRange(range);
    const headers = new Headers();
    if (validatedRange) headers.set('range', validatedRange);
    return safeUpstreamResponse(
      await this.request(url.toString(), { headers }, false, DEFAULT_TRANSFER_TIMEOUT_MS),
      RESPONSE_HEADERS,
    );
  }

  async exportFile(itemId: string, contentType: string): Promise<Response> {
    const url = this.fileUrl(itemId, 'export');
    url.searchParams.set('mimeType', contentType);
    return safeUpstreamResponse(
      await this.request(url.toString(), {}, false, DEFAULT_TRANSFER_TIMEOUT_MS),
      RESPONSE_HEADERS,
    );
  }

  createFolder(parentId: string, name: string): Promise<GoogleFile> {
    return this.createMetadata({ name, mimeType: GOOGLE_FOLDER_MIME_TYPE, parents: [parentId] });
  }

  upload(
    parentId: string,
    name: string,
    body: ReadableStream,
    contentType: string | null,
  ): Promise<GoogleFile> {
    const boundary = `ilist-${crypto.randomUUID()}`;
    const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(
      url.toString(),
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: multipartBody(
          boundary,
          { name, parents: [parentId] },
          contentType ?? 'application/octet-stream',
          body,
        ) as BodyInit,
      },
      DEFAULT_TRANSFER_TIMEOUT_MS,
    );
  }

  async createResumableUpload(
    parentId: string,
    name: string,
    size: number,
    contentType: string | null,
  ): Promise<GoogleUploadSession> {
    const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('fields', FILE_FIELDS);
    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': contentType ?? 'application/octet-stream',
      },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    const sessionUrl = validatedSessionUrl(response.headers.get('location'));
    return { sessionUrl, expiresAt: Date.now() + 6 * 24 * 60 * 60_000 };
  }

  async uploadResumablePart(
    sessionUrl: string,
    body: ReadableStream,
    contentRange: string,
    contentLength: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<GoogleUploadPartResult> {
    const response = await this.requestUploadSession(sessionUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(contentLength),
        'content-type': 'application/octet-stream',
        'content-range': contentRange,
      },
      body: body as BodyInit,
      signal: options.signal,
    });
    if (response.status === 308) {
      const range = response.headers.get('range');
      if (range === null) return { completed: false, nextOffset: 0 };
      const match = /^bytes=0-(\d+)$/.exec(range);
      if (!match) throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
      const lastByte = Number(match[1]);
      if (!Number.isSafeInteger(lastByte)) throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
      return { completed: false, nextOffset: lastByte + 1 };
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
    }
    try {
      return { completed: true, item: await response.json<GoogleFile>() };
    } catch {
      throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_INVALID', 'Google upload session is invalid');
    }
  }

  async abortResumableUpload(sessionUrl: string): Promise<void> {
    const response = await this.requestUploadSession(sessionUrl, { method: 'DELETE' }, true);
    if (response.ok || response.status === 404 || response.status === 410 || response.status === 499) return;
    throw uploadSessionError(response);
  }

  rename(itemId: string, name: string): Promise<GoogleFile> {
    return this.updateMetadata(itemId, { name });
  }

  copy(itemId: string, destinationParentId: string, name: string): Promise<GoogleFile> {
    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(itemId)}/copy`);
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, parents: [destinationParentId] }),
    });
  }

  async move(itemId: string, destinationId: string): Promise<GoogleFile> {
    const current = await this.stat(itemId);
    const url = this.fileUrl(itemId);
    url.searchParams.set('addParents', destinationId);
    if (current.parents?.length) url.searchParams.set('removeParents', current.parents.join(','));
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(url.toString(), { method: 'PATCH' });
  }

  trash(itemId: string): Promise<GoogleFile> {
    return this.updateMetadata(itemId, { trashed: true });
  }

  private createMetadata(metadata: Record<string, unknown>): Promise<GoogleFile> {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }

  private updateMetadata(itemId: string, metadata: Record<string, unknown>): Promise<GoogleFile> {
    const url = this.fileUrl(itemId);
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(url.toString(), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }

  private fileUrl(itemId: string, suffix = ''): URL {
    const path = suffix ? `/files/${encodeURIComponent(itemId)}/${suffix}` : `/files/${encodeURIComponent(itemId)}`;
    return new URL(`${DRIVE_BASE}${path}`);
  }

  private async accessToken(): Promise<string> {
    this.cachedToken ??= await this.tokenProvider(this.env, this.mountId);
    return this.cachedToken;
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
  ): Promise<T> {
    const response = await this.request(url, init, false, timeoutMs);
    try {
      return await response.json<T>();
    } catch {
      throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    }
  }

  private async request(
    url: string,
    init: RequestInit = {},
    retried = false,
    timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
  ): Promise<Response> {
    const accessToken = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    let response: Response;
    try {
      response = await fetchWithRetry(this.fetcher, url, { ...init, headers, timeoutMs });
    } catch {
      throw new HttpError(502, 'GOOGLE_UPSTREAM_FAILED', 'Google Drive request failed');
    }
    if (response.status === 401 && !retried) {
      void response.body?.cancel();
      this.cachedToken = null;
      this.cachedToken = await this.tokenRefresher(this.env, this.mountId, accessToken, this.fetcher);
      if (init.body instanceof ReadableStream) {
        throw new HttpError(401, 'GOOGLE_AUTH_FAILED', 'Google Drive authentication failed');
      }
      return this.request(url, init, true, timeoutMs);
    }
    if (!response.ok) throw await googleError(response);
    return response;
  }

  private async requestUploadSession(
    sessionUrl: string,
    init: RequestInit,
    allowTerminalStatus = false,
  ): Promise<Response> {
    const url = validatedSessionUrl(sessionUrl);
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    let response: Response;
    try {
      response = await fetchWithRetry(this.fetcher, url, {
        ...init,
        headers,
        timeoutMs: DEFAULT_TRANSFER_TIMEOUT_MS,
      });
    } catch {
      throw new HttpError(502, 'GOOGLE_UPLOAD_SESSION_FAILED', 'Google upload session request failed');
    }
    if (response.status === 308 || response.ok || (allowTerminalStatus && [404, 410, 499].includes(response.status))) {
      return response;
    }
    throw uploadSessionError(response);
  }
}
