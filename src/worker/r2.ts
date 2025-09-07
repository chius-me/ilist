import { normalizeKey } from './db';
import { HttpError } from './http';
import type { EntryRow, Env, ObjectRow } from './types';

export function keyFromPath(pathname: string, routePrefix: string): string {
  const raw = pathname.slice(routePrefix.length);
  try {
    return normalizeKey(raw);
  } catch {
    throw new HttpError(400, 'Invalid object key');
  }
}

export async function putObject(env: Env, key: string, request: Request): Promise<R2Object> {
  if (!request.body) throw new HttpError(400, 'Missing request body');

  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  return await env.R2_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
    },
  });
}

function contentDisposition(row: ObjectRow): string {
  const filename = encodeURIComponent(row.name || row.key.split('/').pop() || 'download');
  return `inline; filename*=UTF-8''${filename}`;
}

export async function streamObject(env: Env, row: ObjectRow, request: Request): Promise<Response> {
  const object = await env.R2_BUCKET.get(row.key, {
    range: request.headers,
    onlyIf: request.headers,
  });

  if (!object) throw new HttpError(404, 'File not found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('content-disposition', contentDisposition(row));

  if (!('body' in object)) {
    return new Response(null, { status: 304, headers });
  }

  const status = request.headers.has('range') ? 206 : 200;
  return new Response(object.body, { status, headers });
}

function disposition(name: string, download: boolean): string {
  return `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function streamEntryObject(
  bucket: R2Bucket,
  row: EntryRow,
  request: Request,
  options: { download: boolean; publicFile: boolean },
): Promise<Response> {
  if (row.kind !== 'file' || !row.storage_key || row.status !== 'ready') {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'File not found');
  }

  const object = await bucket.get(row.storage_key, { range: request.headers, onlyIf: request.headers });
  if (!object) throw new HttpError(404, 'STORAGE_OBJECT_NOT_FOUND', 'File content not found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-disposition', disposition(row.name, options.download));
  headers.set('cache-control', options.publicFile ? 'public, max-age=3600' : 'private, no-store');

  if (!('body' in object)) return new Response(null, { status: 304, headers });

  const range = object.range;
  if (
    request.headers.has('range')
    && range
    && 'offset' in range
    && typeof range.offset === 'number'
    && typeof range.length === 'number'
  ) {
    const end = range.offset + range.length - 1;
    headers.set('content-range', `bytes ${range.offset}-${end}/${object.size}`);
    headers.set('content-length', String(range.length));
  }

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: request.headers.has('range') ? 206 : 200,
    headers,
  });
}
