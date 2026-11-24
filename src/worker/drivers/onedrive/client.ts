import { HttpError } from '../../http';
import { bytesToBase64Url, timingSafeEqualStrings } from '../../shared/encoding';
import {
  assertValidRange,
  DEFAULT_METADATA_TIMEOUT_MS,
  DEFAULT_TRANSFER_TIMEOUT_MS,
  fetchWithRetry,
  retryAfterDetails,
  retryAfterSeconds,
  safeUpstreamResponse,
} from '../../shared/http-client';
import { isPrivateOrReservedHost } from '../../shared/ip';
import { deriveSessionHmacKey, legacyRawHmacKey } from '../../shared/keys';
import type { Env } from '../../types';
import { getOneDriveAccessToken, refreshOneDriveAccessToken } from './tokens';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const DRIVE_ITEM_SELECT = 'id,name,size,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,root,specialFolder,@microsoft.graph.downloadUrl';
const DOWNLOAD_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
];
const COPY_POLL_DELAYS_MS = [100, 200, 400, 800, 1_000, 1_500, 2_000] as const;
const MAX_COPY_POLLS = 20;

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

interface GraphCopyMonitorPayload {
  status?: string;
  resourceId?: string;
  error?: {
    code?: string;
    message?: string;
  };
}

type AccessTokenProvider = (env: Env, mountId: string) => Promise<string>;
type AccessTokenRefresher = (
  env: Env,
  mountId: string,
  rejectedAccessToken: string,
  fetcher: typeof fetch,
) => Promise<string>;

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

function graphError(status: number, upstreamCode?: string): HttpError {
  if (status === 401) return new HttpError(401, 'ONEDRIVE_AUTH_FAILED', 'OneDrive authentication failed');
  if (status === 403) return new HttpError(403, 'ONEDRIVE_ACCESS_DENIED', 'OneDrive access was denied');
  if (status === 404) return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'OneDrive item was not found');
  if (status === 409) {
    if (upstreamCode === 'nameAlreadyExists') {
      return new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name');
    }
    return new HttpError(409, 'STORAGE_CONFLICT', 'OneDrive item conflicts with an existing item');
  }
  if (status === 429) return new HttpError(503, 'ONEDRIVE_RATE_LIMITED', 'OneDrive is temporarily rate limited');
  return new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
}

function uploadSessionError(response: Response): HttpError {
  const details = retryAfterDetails(response.headers.get('retry-after'));
  if (response.status === 404) return new HttpError(404, 'ONEDRIVE_UPLOAD_SESSION_NOT_FOUND', 'OneDrive upload session was not found', details);
  if (response.status === 409) return new HttpError(409, 'ONEDRIVE_UPLOAD_SESSION_CONFLICT', 'OneDrive upload session conflicts with the current file', details);
  if (response.status === 416) return new HttpError(409, 'ONEDRIVE_UPLOAD_SESSION_INVALID_RANGE', 'OneDrive upload part range is invalid', details);
  if (response.status === 429) return new HttpError(503, 'ONEDRIVE_UPLOAD_SESSION_RATE_LIMITED', 'OneDrive upload session is temporarily rate limited', details);
  return new HttpError(502, 'ONEDRIVE_UPLOAD_SESSION_FAILED', 'OneDrive upload session request failed', details);
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

function validatedMonitorUrl(value: string | null): URL {
  if (!value) throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive copy monitor URL is missing');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive copy monitor URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateOrReservedHost(url.hostname)) {
    throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive copy monitor URL is not allowed');
  }
  return url;
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

async function readUpstreamErrorCode(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.clone().json<GraphErrorPayload>();
    return payload.error?.code;
  } catch {
    return undefined;
  }
}

async function logGraphError(response: Response, requestUrl: string): Promise<string | undefined> {
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
  return upstreamCode;
}

export class OneDriveClient {
  private cachedToken: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly mountId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly tokenProvider: AccessTokenProvider = getOneDriveAccessToken,
    private readonly tokenRefresher: AccessTokenRefresher = refreshOneDriveAccessToken,
  ) {}

  async list(parentId: string, cursor?: string, limit?: number): Promise<GraphListResult> {
    let url: string;
    if (cursor) {
      url = validatedCursor(cursor);
    } else {
      const target = new URL(withSelect(parentId === 'root'
        ? '/me/drive/root/children'
        : `/me/drive/items/${encodeURIComponent(parentId)}/children`));
      if (limit !== undefined) {
        target.searchParams.set('$top', String(Math.min(Math.max(1, limit), 1000)));
      }
      url = target.toString();
    }
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

  statByPath(rootId: string, segments: string[]): Promise<GraphDriveItem> {
    const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
    const path = rootId === 'root'
      ? `/me/drive/root:/${encodedPath}:`
      : `/me/drive/items/${encodeURIComponent(rootId)}:/${encodedPath}:`;
    return this.requestJson<GraphDriveItem>(withSelect(path));
  }

  getDownloadUrl(itemId: string): Promise<string> {
    return this.requestDownloadUrl(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/content`);
  }

  async download(itemId: string, range: string | null = null): Promise<Response> {
    const checkedRange = assertValidRange(range);
    const downloadUrl = await this.getDownloadUrl(itemId);
    const headers = new Headers();
    if (checkedRange) headers.set('range', checkedRange);
    let response: Response;
    try {
      response = await fetchWithRetry(this.fetcher, downloadUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
        timeoutMs: DEFAULT_TRANSFER_TIMEOUT_MS,
      });
    } catch {
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
    }
    if (!response.ok && response.status !== 206 && response.status !== 304) {
      const code = await readUpstreamErrorCode(response);
      void response.body?.cancel();
      throw graphError(response.status, code);
    }
    return safeUpstreamResponse(response, DOWNLOAD_RESPONSE_HEADERS);
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
    return this.requestJson<GraphDriveItem>(
      url.toString(),
      {
        method: 'PUT',
        headers: { 'content-type': contentType ?? 'application/octet-stream' },
        body: body as BodyInit,
      },
      false,
      DEFAULT_TRANSFER_TIMEOUT_MS,
    );
  }

  async copy(itemId: string, destinationParentId: string, name: string): Promise<GraphDriveItem> {
    const copyUrl = new URL(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/copy`);
    copyUrl.searchParams.set('@microsoft.graph.conflictBehavior', 'fail');
    const response = await this.requestAuthorized(copyUrl.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentReference: { id: destinationParentId },
        name,
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    if (response.status === 200 || response.status === 201) {
      try {
        return await response.json<GraphDriveItem>();
      } catch {
        throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive response was invalid');
      }
    }
    if (response.status !== 202) {
      const code = await logGraphError(response, copyUrl.toString());
      void response.body?.cancel();
      throw graphError(response.status, code);
    }

    const monitorUrl = validatedMonitorUrl(response.headers.get('location'));
    void response.body?.cancel();

    for (let attempt = 0; attempt < MAX_COPY_POLLS; attempt += 1) {
      let pollResponse: Response;
      try {
        pollResponse = await fetchWithRetry(this.fetcher, monitorUrl.toString(), {
          method: 'GET',
          headers: monitorUrl.origin === GRAPH_ORIGIN
            ? { authorization: `Bearer ${await this.accessToken()}` }
            : undefined,
          timeoutMs: DEFAULT_METADATA_TIMEOUT_MS,
        });
      } catch {
        throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive copy request failed');
      }
      if (!pollResponse.ok) {
        const code = await logGraphError(pollResponse, monitorUrl.toString());
        void pollResponse.body?.cancel();
        throw graphError(pollResponse.status, code);
      }
      let statusPayload: GraphCopyMonitorPayload;
      try {
        statusPayload = await pollResponse.json<GraphCopyMonitorPayload>();
      } catch {
        throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive copy status response was invalid');
      }
      if (statusPayload.status === 'completed' && typeof statusPayload.resourceId === 'string' && statusPayload.resourceId) {
        return this.stat(statusPayload.resourceId);
      }
      if (statusPayload.status === 'failed' || statusPayload.status === 'cancelled') {
        if (statusPayload.error?.code === 'nameAlreadyExists') {
          throw new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name');
        }
        throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive copy failed');
      }

      const retrySeconds = retryAfterSeconds(pollResponse.headers.get('retry-after'));
      const fallbackDelay = COPY_POLL_DELAYS_MS[Math.min(attempt, COPY_POLL_DELAYS_MS.length - 1)]!;
      const delayMs = retrySeconds !== null ? Math.min(retrySeconds * 1000, 2_000) : fallbackDelay;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive copy timed out');
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
    }, DEFAULT_TRANSFER_TIMEOUT_MS);
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

  private async accessToken(): Promise<string> {
    this.cachedToken ??= await this.tokenProvider(this.env, this.mountId);
    return this.cachedToken;
  }

  private async requestDownloadUrl(url: string, retried = false): Promise<string> {
    const accessToken = await this.accessToken();
    let response: Response;
    try {
      response = await fetchWithRetry(this.fetcher, url, {
        method: 'GET',
        redirect: 'manual',
        headers: { authorization: `Bearer ${accessToken}` },
        timeoutMs: DEFAULT_METADATA_TIMEOUT_MS,
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
      void response.body?.cancel();
      this.cachedToken = null;
      this.cachedToken = await this.tokenRefresher(this.env, this.mountId, accessToken, this.fetcher);
      return this.requestDownloadUrl(url, true);
    }
    if (response.status !== 302) {
      const code = await logGraphError(response, url);
      throw graphError(response.status, code);
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

  private async requestUploadSession(
    session: GraphUploadSession,
    init: RequestInit,
    timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
  ): Promise<{ response: Response; session: GraphUploadSession }> {
    const verifiedSession = await this.verifyUploadSession(session);
    const { uploadUrl: url } = verifiedSession;
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    let response: Response;
    try {
      response = await fetchWithRetry(this.fetcher, url, { ...init, headers, timeoutMs });
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
    if (!timingSafeEqualStrings(expectedProof, session.integrityProof)) {
      const legacyProof = await this.legacyUploadSessionProof(validated.uploadUrl, validated.expirationDateTime);
      if (!timingSafeEqualStrings(legacyProof, session.integrityProof)) throw invalidUploadSessionProof();
    }
    return { ...validated, integrityProof: session.integrityProof };
  }

  private async uploadSessionProof(uploadUrl: string, expirationDateTime: string): Promise<string> {
    const payload = JSON.stringify({ v: UPLOAD_SESSION_PROOF_VERSION, mountId: this.mountId, uploadUrl, expirationDateTime });
    const key = await deriveSessionHmacKey(this.env.SESSION_SECRET, 'onedrive-upload');
    return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
  }

  private async legacyUploadSessionProof(uploadUrl: string, expirationDateTime: string): Promise<string> {
    const payload = JSON.stringify({ v: UPLOAD_SESSION_PROOF_VERSION, mountId: this.mountId, uploadUrl, expirationDateTime });
    const key = await legacyRawHmacKey(this.env.SESSION_SECRET);
    return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
  }

  private async requestAuthorized(
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
    } catch (error) {
      console.error('OneDrive Graph fetch failed', {
        path: new URL(url).pathname,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
    }
    if (response.status === 401 && !retried) {
      void response.body?.cancel();
      this.cachedToken = null;
      this.cachedToken = await this.tokenRefresher(this.env, this.mountId, accessToken, this.fetcher);
      if (init.body instanceof ReadableStream) throw graphError(401);
      return this.requestAuthorized(url, init, true, timeoutMs);
    }
    return response;
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit = {},
    retried = false,
    timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
  ): Promise<T> {
    const response = await this.requestAuthorized(url, init, retried, timeoutMs);
    if (!response.ok) {
      const code = await logGraphError(response, url);
      throw graphError(response.status, code);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json<T>(); } catch {
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive response was invalid');
    }
  }
}
