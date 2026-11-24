import { currentUser } from '../auth';
import { listExternalDirectory, requireExternalCapability, resolveExternalEntry } from '../external-entries';
import { secureFileResponse } from '../file-response-security';
import { listVirtualDirectory } from '../file-system';
import { fail, HttpError, ok } from '../http';
import { resolveVirtualPath } from '../mount-resolver';
import { listMounts } from '../mounts';
import type { Env } from '../types';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const GUEST_LIST_CACHE_TTL_SECONDS = 60;

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

function parseLimitParam(value: string | null): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function defaultEdgeCache(): Cache | null {
  if (typeof caches === 'undefined') return null;
  const candidate = (caches as unknown as { default?: Cache }).default;
  return candidate ?? null;
}

export async function handleFilesystem(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed();
  const admin = Boolean(await currentUser(env, request));

  if (url.pathname === '/api/fs/list') {
    const pathname = url.searchParams.get('path') ?? '/';
    const nameFilter = url.searchParams.get('q') ?? url.searchParams.get('name');
    const cursor = url.searchParams.get('cursor');
    const limit = parseLimitParam(url.searchParams.get('limit'));
    const cache = defaultEdgeCache();

    if (!admin && !nameFilter && pathname !== '/' && url.searchParams.get('refresh') !== '1' && cache) {
      const mounts = await listMounts(env.DB);
      const { mount, relativePath } = resolveVirtualPath(pathname, mounts.filter((candidate) => candidate.isPublic));
      if (mount.driverType === 'native-r2' || mount.driverType === 'pikpak') {
        throw new HttpError(503, 'DRIVER_UNAVAILABLE', 'Storage driver is unavailable');
      }

      const cacheKey = new Request(
        `https://ilist-cache.internal/list/${mount.id}/${encodeURIComponent(mount.updatedAt)}/${encodeURIComponent(relativePath)}?cursor=${encodeURIComponent(cursor ?? '')}&limit=${encodeURIComponent(limit === undefined ? '' : String(limit))}`,
      );
      const cached = await cache.match(cacheKey);
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: {
            'content-type': JSON_CONTENT_TYPE,
            'cache-control': 'private, no-store',
          },
        });
      }

      const data = await listExternalDirectory(env, mount, relativePath, false, null, { cursor, limit });
      const body = JSON.stringify({ ok: true, data });
      const cacheWrite = cache.put(
        cacheKey,
        new Response(body, {
          status: 200,
          headers: {
            'content-type': JSON_CONTENT_TYPE,
            'cache-control': `public, max-age=${GUEST_LIST_CACHE_TTL_SECONDS}`,
          },
        }),
      ).catch(() => undefined);
      if (ctx) ctx.waitUntil(cacheWrite);
      else await cacheWrite;

      return new Response(body, {
        status: 200,
        headers: {
          'content-type': JSON_CONTENT_TYPE,
          'cache-control': 'private, no-store',
        },
      });
    }

    return ok(await listVirtualDirectory(env, pathname, admin, nameFilter, { cursor, limit }));
  }

  const match = /^\/api\/fs\/entries\/(.+)$/.exec(url.pathname);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    }
    const external = await resolveExternalEntry(env, id, admin);
    if (!external) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    return ok(external.entry);
  }

  throw new HttpError(404, 'Not found');
}

export async function handleFile(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();

  let suffix: string;
  try {
    suffix = decodeURIComponent(url.pathname.slice('/file/'.length));
  } catch {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  }
  const [candidateId] = suffix.split('/');
  const admin = Boolean(await currentUser(env, request));
  const external = await resolveExternalEntry(env, candidateId ?? '', admin);
  if (!external) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  if (external.item.kind !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Entry is not a file');
  requireExternalCapability(external.driver, 'download');
  const download = await external.driver.getDownload(external.identity.itemId, request);
  if (download.kind === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: { location: download.url, 'cache-control': 'private, no-store' },
    });
  }
  const requestedExport = url.searchParams.get('export');
  const exportOption = requestedExport
    ? external.item.exportOptions?.find((option) => option.format === requestedExport)
    : undefined;
  return secureFileResponse(download.response, {
    filename: exportOption ? `${external.item.name}.${exportOption.extension}` : external.item.name,
    contentType: exportOption?.contentType ?? external.item.contentType,
    download: url.searchParams.get('download') === '1',
    sandboxedPreview: url.searchParams.get('preview') === '1',
    publicFile: external.mount.isPublic,
    method: request.method,
    https: url.protocol === 'https:',
  });
}
