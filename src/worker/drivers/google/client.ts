import { HttpError } from '../../http';
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

function validRange(value: string | null): string | null {
  if (value === null) return null;
  if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(value.trim())) {
    throw new HttpError(400, 'INVALID_RANGE', 'Range header is invalid');
  }
  return value.trim();
}

function safeResponse(response: Response): Response {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(prefix);
      const reader = body.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          controller.enqueue(result.value);
        }
        controller.enqueue(suffix);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
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
  constructor(
    private readonly env: Env,
    private readonly mountId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tokenProvider: AccessTokenProvider = getGoogleAccessToken,
    private readonly tokenRefresher: AccessTokenRefresher = refreshGoogleAccessToken,
  ) {}

  async list(parentId: string, cursor?: string): Promise<GoogleListResult> {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set('q', `'${escapeQueryLiteral(parentId)}' in parents and trashed=false`);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('pageSize', '1000');
    if (cursor) url.searchParams.set('pageToken', cursor);
    const payload = await this.requestJson<GoogleListPayload>(url.toString());
    if (!Array.isArray(payload.files)) throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    if (payload.nextPageToken !== undefined && typeof payload.nextPageToken !== 'string') {
      throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    }
    return { items: payload.files, nextCursor: payload.nextPageToken ?? null };
  }

  stat(itemId: string): Promise<GoogleFile> {
    const url = this.fileUrl(itemId);
    url.searchParams.set('fields', FILE_FIELDS);
    return this.requestJson<GoogleFile>(url.toString());
  }

  async download(itemId: string, range: string | null = null): Promise<Response> {
    const url = this.fileUrl(itemId);
    url.searchParams.set('alt', 'media');
    const validatedRange = validRange(range);
    const headers = new Headers();
    if (validatedRange) headers.set('range', validatedRange);
    return safeResponse(await this.request(url.toString(), { headers }));
  }

  async exportFile(itemId: string, contentType: string): Promise<Response> {
    const url = this.fileUrl(itemId, 'export');
    url.searchParams.set('mimeType', contentType);
    return safeResponse(await this.request(url.toString()));
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
    return this.requestJson<GoogleFile>(url.toString(), {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: multipartBody(
        boundary,
        { name, parents: [parentId] },
        contentType ?? 'application/octet-stream',
        body,
      ) as BodyInit,
    });
  }

  rename(itemId: string, name: string): Promise<GoogleFile> {
    return this.updateMetadata(itemId, { name });
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

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    try {
      return await response.json<T>();
    } catch {
      throw new HttpError(502, 'GOOGLE_UPSTREAM_INVALID', 'Google Drive response was invalid');
    }
  }

  private async request(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const accessToken = await this.tokenProvider(this.env, this.mountId);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, url, { ...init, headers });
    } catch {
      throw new HttpError(502, 'GOOGLE_UPSTREAM_FAILED', 'Google Drive request failed');
    }
    if (response.status === 401 && !retried) {
      await this.tokenRefresher(this.env, this.mountId, accessToken, this.fetcher);
      return this.request(url, init, true);
    }
    if (!response.ok) throw await googleError(response);
    return response;
  }
}
