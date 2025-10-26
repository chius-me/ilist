import { HttpError } from '../../http';
import type { Env } from '../../types';
import { getOneDriveAccessToken, refreshOneDriveAccessToken } from './tokens';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const DRIVE_ITEM_SELECT = 'id,name,size,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,@microsoft.graph.downloadUrl';

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
  '@microsoft.graph.downloadUrl'?: string;
}

export interface GraphListResult {
  items: GraphDriveItem[];
  nextCursor: string | null;
}

interface GraphListPayload {
  value?: GraphDriveItem[];
  '@odata.nextLink'?: string;
}

type AccessTokenProvider = (env: Env, mountId: string) => Promise<string>;

function graphError(status: number): HttpError {
  if (status === 401) return new HttpError(401, 'ONEDRIVE_AUTH_FAILED', 'OneDrive authentication failed');
  if (status === 403) return new HttpError(403, 'ONEDRIVE_ACCESS_DENIED', 'OneDrive access was denied');
  if (status === 404) return new HttpError(404, 'STORAGE_ITEM_NOT_FOUND', 'OneDrive item was not found');
  if (status === 409) return new HttpError(409, 'STORAGE_CONFLICT', 'OneDrive item conflicts with an existing item');
  if (status === 429) return new HttpError(503, 'ONEDRIVE_RATE_LIMITED', 'OneDrive is temporarily rate limited');
  return new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
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

  private async requestJson<T>(url: string, retried = false): Promise<T> {
    const accessToken = await this.tokenProvider(this.env, this.mountId);
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: { authorization: `Bearer ${accessToken}` } });
    } catch {
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_FAILED', 'OneDrive request failed');
    }
    if (response.status === 401 && !retried) {
      await refreshOneDriveAccessToken(this.env, this.mountId, accessToken, this.fetcher);
      return this.requestJson<T>(url, true);
    }
    if (!response.ok) throw graphError(response.status);
    try { return await response.json<T>(); } catch {
      throw new HttpError(502, 'ONEDRIVE_UPSTREAM_INVALID', 'OneDrive response was invalid');
    }
  }
}
