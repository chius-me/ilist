import { normalizeKey } from './db';
import { secureFileResponse } from './file-response-security';
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

  if (!('body' in object)) {
    return secureFileResponse(new Response(null, { status: 304, headers }), {
      filename: row.name || row.key.split('/').pop() || 'download',
      contentType: row.content_type,
      download: new URL(request.url).searchParams.get('download') === '1',
      publicFile: row.is_public === 1,
      method: request.method,
    });
  }

  const status = request.headers.has('range') ? 206 : 200;
  return secureFileResponse(new Response(object.body, { status, headers }), {
    filename: row.name || row.key.split('/').pop() || 'download',
    contentType: row.content_type,
    download: new URL(request.url).searchParams.get('download') === '1',
    publicFile: row.is_public === 1,
    method: request.method,
  });
}

type ByteRange = { offset: number; length: number };

function parseByteRange(value: string | null, size: number): ByteRange | null | 'invalid' {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  const [, startValue, endValue] = match;
  const start = startValue ? Number(startValue) : undefined;
  const end = endValue ? Number(endValue) : undefined;
  if ((start !== undefined && !Number.isSafeInteger(start)) || (end !== undefined && !Number.isSafeInteger(end))) return 'invalid';

  if (start === undefined) {
    if (!end || size === 0) return 'invalid';
    const length = Math.min(end, size);
    return { offset: size - length, length };
  }
  if (start >= size || (end !== undefined && end < start)) return 'invalid';
  const finalByte = end === undefined ? size - 1 : Math.min(end, size - 1);
  return { offset: start, length: finalByte - start + 1 };
}

function etagMatches(header: string, etag: string, weak: boolean): boolean {
  const normalize = (tag: string) => weak ? tag.replace(/^W\//, '') : tag;
  const expected = normalize(etag);
  return header.split(',').map((tag) => tag.trim()).some((tag) => tag === '*' || (
    (weak || !tag.startsWith('W/')) && normalize(tag) === expected
  ));
}

function validHttpDate(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function preconditionStatus(request: Request, object: R2Object): 304 | 412 | null {
  const method = request.method.toUpperCase();
  const safe = method === 'GET' || method === 'HEAD';
  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null && !etagMatches(ifMatch, object.httpEtag, false)) return 412;

  if (ifMatch === null) {
    const unmodifiedSince = validHttpDate(request.headers.get('if-unmodified-since'));
    if (
      unmodifiedSince !== null
      && Math.floor(object.uploaded.getTime() / 1000) > Math.floor(unmodifiedSince / 1000)
    ) return 412;
  }

  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null) {
    if (!etagMatches(ifNoneMatch, object.httpEtag, true)) return null;
    return safe ? 304 : 412;
  }

  if (safe) {
    const modifiedSince = validHttpDate(request.headers.get('if-modified-since'));
    if (modifiedSince !== null && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(modifiedSince / 1000)) return 304;
  }
  return null;
}

function ifRangeMatches(request: Request, object: R2Object): boolean {
  const ifRange = request.headers.get('if-range');
  if (ifRange === null) return true;
  if (ifRange.startsWith('W/')) return false;
  if (ifRange.startsWith('"')) return ifRange === object.httpEtag;
  const date = validHttpDate(ifRange);
  return date !== null && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(date / 1000);
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  return headers;
}

function secureEntryResponse(
  response: Response,
  row: EntryRow,
  request: Request,
  options: { download: boolean; publicFile: boolean },
): Response {
  return secureFileResponse(response, {
    filename: row.name,
    contentType: row.content_type,
    download: options.download,
    publicFile: options.publicFile,
    method: request.method,
  });
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

  const metadata = await bucket.head(row.storage_key);
  if (!metadata) throw new HttpError(404, 'STORAGE_OBJECT_NOT_FOUND', 'File content not found');
  const headers = objectHeaders(metadata);
  const conditional = preconditionStatus(request, metadata);
  if (conditional !== null) return secureEntryResponse(new Response(null, { status: conditional, headers }), row, request, options);

  const requestedRange = ifRangeMatches(request, metadata)
    ? parseByteRange(request.headers.get('range'), metadata.size)
    : null;
  if (requestedRange === 'invalid') {
    headers.set('content-range', `bytes */${metadata.size}`);
    return secureEntryResponse(new Response(null, { status: 416, headers }), row, request, options);
  }

  const object = await bucket.get(row.storage_key, requestedRange ? { range: requestedRange } : undefined);
  if (!object) throw new HttpError(404, 'STORAGE_OBJECT_NOT_FOUND', 'File content not found');
  const responseHeaders = objectHeaders(object);
  const range = object.range;
  const partialRange = requestedRange !== null
    && range
    && 'offset' in range
    && typeof range.offset === 'number'
    && typeof range.length === 'number'
    ? { offset: range.offset, length: range.length }
    : null;
  if (partialRange) {
    const end = partialRange.offset + partialRange.length - 1;
    responseHeaders.set('content-range', `bytes ${partialRange.offset}-${end}/${object.size}`);
    responseHeaders.set('content-length', String(partialRange.length));
  } else {
    responseHeaders.set('content-length', String(object.size));
  }

  return secureEntryResponse(new Response(request.method.toUpperCase() === 'HEAD' ? null : object.body, {
    status: partialRange ? 206 : 200,
    headers: responseHeaders,
  }), row, request, options);
}
