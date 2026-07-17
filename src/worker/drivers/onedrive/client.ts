import { HttpError } from '../../http';
import type { Env } from '../../types';
import { getOneDriveAccessToken, refreshOneDriveAccessToken } from './tokens';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const DRIVE_ITEM_SELECT = 'id,name,size,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,root,specialFolder,@microsoft.graph.downloadUrl';

export interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  parentReference?: { id?: string };
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  package?: { type?: string };
  root?: Record<string, never>;
  specialFolder?: { name?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

export interface GraphListResult {
  items: GraphDriveItem[];
  nextCursor: string | null;
}

export interface GraphUploadSession {
  uploadUrl: string;
  expirationDateTime: string;
  integrityProof: string;
  nextExpectedRanges?: string[];
}

export type GraphUploadPartResult =
  | { completed: false; nextExpectedRanges: string[]; session: GraphUploadSession }
  | { completed: true; item: GraphDriveItem };

export interface UploadSessionRequestOptions {
  signal?: AbortSignal;
}

export interface GraphItemUpdate {
  name?: string;
  parentReference?: { id: string };
}

interface GraphListPayload {
  value?: GraphDriveItem[];
  '@odata.nextLink'?: string;
}

interface GraphErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

type AccessTokenProvider = (env: Env, mountId: string) => Promise<string>;

interface GraphUploadSessionPayload {
  uploadUrl: string;
  expirationDateTime: string;
  nextExpectedRanges?: string[];
}

interface GraphUploadSessionStatusPayload {
  expirationDateTime: string;
  nextExpectedRanges: string[];
}

const UPLOAD_SESSION_PROOF_VERSION = 1;
const encoder = new TextEncoder();

function graphError(status: number): HttpError {
  if (status === 401) return new HttpError(401, 'ONEDRIVE_AUTH_FAILED', 'OneDrive authentication failed');
  if (status === 403) return new HttpError(403, 'ONEDRIVE_ACCESS_DENIED', 'OneDrive access was denied');
  if (status === 404) return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'OneDrive item was not found');
  if (status === 409) return new HttpError(409, 'STORAGE_CONFLICT', 'OneDrive item conflicts with an existing item');
  if (status === 429) return new HttpError(503, 'ONEDRIVE_RATE_LIMITED', 'OneDrive is temporarily rate limited');
  return new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
}

function uploadSessionError(response: Response): HttpError {
  const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
  const details = retryAfter === null ? undefined : { retryAfter };
  if (response.status === 404) return new HttpError(404, 'ONEDRIVE_UPLOAD_SESSION_NOT_FOUND', 'OneDrive upload session was not found', details);
  if (response.status === 409) return new HttpError(409, 'ONEDRIVE_UPLOAD_SESSION_CONFLICT', 'OneDrive upload session conflicts with the current file', details);
  if (response.status === 416) return new HttpError(409, 'ONEDRIVE_UPLOAD_SESSION_INVALID_RANGE', 'OneDrive upload part range is invalid', details);
  if (response.status === 429) return new HttpError(503, 'ONEDRIVE_UPLOAD_SESSION_RATE_LIMITED', 'OneDrive upload session is temporarily rate limited', details);
  return new HttpError(502, 'ONEDRIVE_UPLOAD_SESSION_FAILED', 'OneDrive upload session request failed', details);
}

function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function invalidUploadSession(): HttpError {
  return new HttpError(502, 'ONEDRIVE_UPLOAD_SESSION_INVALID', 'OneDrive upload session response was invalid');
}

function invalidUploadSessionProof(): HttpError {
  return new HttpError(400, 'ONEDRIVE_UPLOAD_SESSION_PROOF_INVALID', 'OneDrive upload session proof is invalid');
}

function validatedUploadSessionUrl(value: unknown): string {
  if (typeof value !== 'string') throw invalidUploadSession();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Invalid upload session protocol');
    return value;
  } catch {
    throw invalidUploadSession();
  }
}

function validatedExpirationDateTime(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalidUploadSession();
  return value;
}

function validatedNextExpectedRanges(value: unknown, required: boolean): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.some((range) => typeof range !== 'string')) throw invalidUploadSession();
  return value;
}

function validatedUploadSession(value: unknown): GraphUploadSessionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidUploadSession();
  const payload = value as Record<string, unknown>;
  const nextExpectedRanges = validatedNextExpectedRanges(payload.nextExpectedRanges, false);
  return {
    uploadUrl: validatedUploadSessionUrl(payload.uploadUrl),
    expirationDateTime: validatedExpirationDateTime(payload.expirationDateTime),
    ...(nextExpectedRanges === undefined ? {} : { nextExpectedRanges }),
  };
}

function validatedUploadSessionStatus(value: unknown): GraphUploadSessionStatusPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidUploadSession();
  const payload = value as Record<string, unknown>;
  return {
    expirationDateTime: validatedExpirationDateTime(payload.expirationDateTime),
    nextExpectedRanges: validatedNextExpectedRanges(payload.nextExpectedRanges, true)!,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

function validatedCursor(cursor: string): string {
  let url: URL;
  try { url = new URL(cursor); } catch { throw new HttpError(400, 'INVALID_ONEDRIVE_CURSOR', 'OneDrive cursor is invalid'); }
  if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith('/v1.0/')) {
    throw new HttpError(400, 'INVALID_ONEDRIVE_CURSOR', 'OneDrive cursor is invalid');
  }
  return url.toString();
}

function withSelect(path: string): string {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('$select', DRIVE_ITEM_SELECT);
  return url.toString();
}

async function logGraphError(response: Response, requestUrl: string): Promise<void> {
  let upstreamCode: string | undefined;
  let upstreamMessage: string | undefined;
  try {
    const payload = await response.clone().json<GraphErrorPayload>();
    upstreamCode = payload.error?.code;
    upstreamMessage = payload.error?.message;
  } catch {
    // Some Graph failures do not include a JSON response body.
  }
  const url = new URL(requestUrl);
  console.error('OneDrive Graph request failed', {
    status: response.status,
    path: url.pathname,
    upstreamCode,
    upstreamMessage,
    requestId: response.headers.get('request-id'),
  });
}

export class OneDriveClient {
  constructor(
    private readonly env: Env,
    private readonly mountId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tokenProvider: AccessTokenProvider = getOneDriveAccessToken,
  ) {}

  async list(parentId: string, cursor?: string): Promise<GraphListResult> {
    const url = cursor
      ? validatedCursor(cursor)
      : withSelect(parentId === 'root'
        ? '/me/drive/root/children'
        : `/me/drive/items/${encodeURIComponent(parentId)}/children`);
    const payload = await this.requestJson<GraphListPayload>(url);
    if (!Array.isArray(payload.value)) throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive response was invalid');
    const nextCursor = payload['@odata.nextLink'];
    if (nextCursor !== undefined) validatedCursor(nextCursor);
    return { items: payload.value, nextCursor: nextCursor ?? null };
  }

  stat(itemId: string): Promise<GraphDriveItem> {
    return this.requestJson<GraphDriveItem>(withSelect(itemId === 'root'
      ? '/me/drive/root'
      : `/me/drive/items/${encodeURIComponent(itemId)}`));
  }

  getDownloadUrl(itemId: string): Promise<string> {
    return this.requestDownloadUrl(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/content`);
  }

  createFolder(parentId: string, name: string): Promise<GraphDriveItem> {
    const path = parentId === 'root'
      ? '/me/drive/root/children'
      : `/me/drive/items/${encodeURIComponent(parentId)}/children`;
    return this.requestJson<GraphDriveItem>(withSelect(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
  }

  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<GraphDriveItem> {
    const encodedName = encodeURIComponent(name);
    const path = parentId === 'root'
      ? `/me/drive/root:/${encodedName}:/content`
      : `/me/drive/items/${encodeURIComponent(parentId)}:/${encodedName}:/content`;
    const url = new URL(`${GRAPH_BASE}${path}`);
    url.searchParams.set('@microsoft.graph.conflictBehavior', 'fail');
    return this.requestJson<GraphDriveItem>(url.toString(), {
      method: 'PUT',
      headers: { 'content-type': contentType ?? 'application/octet-stream' },
      body: body as BodyInit,
    });
  }

  async createUploadSession(parentId: string, name: string): Promise<GraphUploadSession> {
    const encodedName = encodeURIComponent(name);
    const path = parentId === 'root'
      ? `/me/drive/root:/${encodedName}:/createUploadSession`
      : `/me/drive/items/${encodeURIComponent(parentId)}:/${encodedName}:/createUploadSession`;
    return this.signUploadSession(validatedUploadSession(await this.requestJson<unknown>(`${GRAPH_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
    })));
  }

  async uploadSessionPart(
    session: GraphUploadSession,
    body: ReadableStream,
    contentRange: string,
    contentLength: number,
    options: UploadSessionRequestOptions = {},
  ): Promise<GraphUploadPartResult> {
    const request = await this.requestUploadSession(session, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(contentLength),
        'content-range': contentRange,
      },
      body: body as BodyInit,
      signal: options.signal,
    });
    if (request.response.status === 202) {
      const status = validatedUploadSessionStatus(await this.readUploadSessionJson(request.response));
      return {
        completed: false,
        nextExpectedRanges: status.nextExpectedRanges,
        session: await this.signUploadSession({ uploadUrl: request.session.uploadUrl, ...status }),
      };
    }
    if (request.response.status === 200 || request.response.status === 201) {
      return { completed: true, item: await this.readUploadSessionJson<GraphDriveItem>(request.response) };
    }
    throw invalidUploadSession();
  }

  async getUploadSessionStatus(session: GraphUploadSession): Promise<GraphUploadSession> {
    const request = await this.requestUploadSession(session, { method: 'GET' });
    const status = validatedUploadSessionStatus(await this.readUploadSessionJson(request.response));
    return this.signUploadSession({ uploadUrl: request.session.uploadUrl, ...status });
  }

  async cancelUploadSession(session: GraphUploadSession): Promise<void> {
    try {
      await this.requestUploadSession(session, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'ONEDRIVE_UPLOAD_SESSION_NOT_FOUND') throw error;
    }
  }

  update(itemId: string, update: GraphItemUpdate): Promise<GraphDriveItem> {
    return this.requestJson<GraphDriveItem>(withSelect(`/me/drive/items/${encodeURIComponent(itemId)}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
  }

  async remove(itemId: string): Promise<void> {
    await this.requestJson<void>(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  }

  private async requestDownloadUrl(url: string, retried = false): Promise<string> {
    const accessToken = await this.tokenProvider(this.env, this.mountId);
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher.call(globalThis, url, {
        method: 'GET',
        redirect: 'manual',
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      console.error('OneDrive Graph fetch failed', {
        path: new URL(url).pathname,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
    }
    if (response.status === 401 && !retried) {
      await refreshOneDriveAccessToken(this.env, this.mountId, accessToken, this.fetcher);
      return this.requestDownloadUrl(url, true);
    }
    if (response.status !== 302) {
      await logGraphError(response, url);
      throw graphError(response.status);
    }
    const location = response.headers.get('location');
    if (!location) throw new HttpError(502, 'ONEDRIVE_DOWNLOAD_UNAVAILABLE', 'OneDrive download is unavailable');
    try {
      const downloadUrl = new URL(location);
      if (downloadUrl.protocol !== 'https:') throw new Error('Invalid download protocol');
      return downloadUrl.toString();
    } catch {
      throw new HttpError(502, 'ONEDRIVE_DOWNLOAD_UNAVAILABLE', 'OneDrive download is unavailable');
    }
  }

  private async requestUploadSession(session: GraphUploadSession, init: RequestInit): Promise<{ response: Response; session: GraphUploadSession }> {
    const verifiedSession = await this.verifyUploadSession(session);
    const { uploadUrl: url } = verifiedSession;
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher.call(globalThis, url, { ...init, headers });
    } catch (error) {
      console.error('OneDrive upload session fetch failed', {
        errorName: error instanceof Error ? error.name : undefined,
      });
      throw new HttpError(502, 'ONEDRIVE_UPLOAD_SESSION_FAILED', 'OneDrive upload session request failed');
    }
    if (!response.ok) throw uploadSessionError(response);
    return { response, session: verifiedSession };
  }

  private async readUploadSessionJson<T = Record<string, unknown>>(response: Response): Promise<T> {
    try { return await response.json<T>(); } catch { throw invalidUploadSession(); }
  }

  private async signUploadSession(session: GraphUploadSessionPayload): Promise<GraphUploadSession> {
    if (Date.parse(session.expirationDateTime) <= Date.now()) throw invalidUploadSession();
    return { ...session, integrityProof: await this.uploadSessionProof(session.uploadUrl, session.expirationDateTime) };
  }

  private async verifyUploadSession(session: GraphUploadSession): Promise<GraphUploadSession> {
    const validated = validatedUploadSession(session);
    if (Date.parse(validated.expirationDateTime) <= Date.now()) throw invalidUploadSession();
    if (typeof session.integrityProof !== 'string' || !session.integrityProof) throw invalidUploadSessionProof();
    const expectedProof = await this.uploadSessionProof(validated.uploadUrl, validated.expirationDateTime);
    if (!constantTimeEqual(expectedProof, session.integrityProof)) throw invalidUploadSessionProof();
    return { ...validated, integrityProof: session.integrityProof };
  }

  private async uploadSessionProof(uploadUrl: string, expirationDateTime: string): Promise<string> {
    const payload = JSON.stringify({ v: UPLOAD_SESSION_PROOF_VERSION, mountId: this.mountId, uploadUrl, expirationDateTime });
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
  }

  private async requestJson<T>(url: string, init: RequestInit = {}, retried = false): Promise<T> {
    const accessToken = await this.tokenProvider(this.env, this.mountId);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher.call(globalThis, url, { ...init, headers });
    } catch (error) {
      console.error('OneDrive Graph fetch failed', {
        path: new URL(url).pathname,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
    }
    if (response.status === 401 && !retried) {
      await refreshOneDriveAccessToken(this.env, this.mountId, accessToken, this.fetcher);
      if (init.body instanceof ReadableStream) throw graphError(401);
      return this.requestJson<T>(url, init, true);
    }
    if (!response.ok) {
      await logGraphError(response, url);
      throw graphError(response.status);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json<T>(); } catch {
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive response was invalid');
    }
  }
}
