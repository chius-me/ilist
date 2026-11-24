import { requireAdminSession } from './auth';
import { fail, HttpError, noContent, ok, requireSameOrigin } from './http';
import { handleMountRoutes } from './mount-routes';
import { handleOAuthRoutes } from './oauth-routes';
import { withApplicationSecurityHeaders } from './response-security';
import { handleAdminEntryRoutes } from './routes/admin-entries';
import { handleLogin, handleLogout, type RouteRequestOptions } from './routes/auth';
import { handleFile, handleFilesystem } from './routes/fs';
import { handleShareAdminRoutes } from './share-admin-routes';
import { handleSharePublicRoutes } from './share-public-routes';
import type { Env } from './types';
import { handleUploadRoutes } from './upload-routes';

export type { RouteRequestOptions };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  options: RouteRequestOptions,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (url.pathname === '/api/admin/login') return handleLogin(request, env, options);
  if (url.pathname === '/api/admin/logout') return handleLogout(request, env);

  const session = await requireAdminSession(env, request);
  if (request.method !== 'GET') requireSameOrigin(request);

  if (url.pathname === '/api/admin/me') {
    if (request.method !== 'GET') return methodNotAllowed();
    return ok(session.user);
  }

  const uploadResponse = await handleUploadRoutes(request, env, url, session.id, ctx);
  if (uploadResponse) return uploadResponse;

  const oauthResponse = await handleOAuthRoutes(request, env, url);
  if (oauthResponse) return oauthResponse;

  const mountResponse = await handleMountRoutes(request, env, url);
  if (mountResponse) return mountResponse;

  const shareResponse = await handleShareAdminRoutes(request, env, url);
  if (shareResponse) return shareResponse;

  const entryResponse = await handleAdminEntryRoutes(request, env, url);
  if (entryResponse) return entryResponse;

  throw new HttpError(404, 'Not found');
}

function withPrivateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withAppropriateSecurityHeaders(response: Response, request: Request): Response {
  return response.headers.get('content-security-policy')?.startsWith('sandbox;')
    ? response
    : withApplicationSecurityHeaders(response, request);
}

export async function routeRequest(
  request: Request,
  env: Env,
  options: RouteRequestOptions = {},
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return withApplicationSecurityHeaders(noContent(JSON_HEADERS), request);
  }

  try {
    if (url.pathname.startsWith('/s/')) {
      const shareResponse = await handleSharePublicRoutes(request, env, url, options.passwordAuthentication, ctx);
      return withAppropriateSecurityHeaders(withPrivateNoStore(shareResponse ?? await env.ASSETS.fetch(request)), request);
    }
    if (url.pathname.startsWith('/api/fs/')) {
      return withApplicationSecurityHeaders(await handleFilesystem(request, env, url, ctx), request);
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return withApplicationSecurityHeaders(await handleAdmin(request, env, url, options, ctx), request);
    }
    if (url.pathname.startsWith('/file/')) {
      return withAppropriateSecurityHeaders(await handleFile(request, env, url), request);
    }

    return withApplicationSecurityHeaders(await env.ASSETS.fetch(request), request);
  } catch (error) {
    if (error instanceof HttpError) {
      const response = fail(error.status, error.code, error.message, error.details);
      if (error.code === 'AUTH_RATE_LIMITED'
        && typeof error.details === 'object' && error.details !== null
        && 'retryAfter' in error.details && Number.isInteger(error.details.retryAfter)) {
        response.headers.set('retry-after', String(error.details.retryAfter));
      }
      return withApplicationSecurityHeaders(url.pathname.startsWith('/s/') ? withPrivateNoStore(response) : response, request);
    }
    console.error(JSON.stringify({
      event: 'unhandled_worker_error',
      path: url.pathname,
      method: request.method,
      message: error instanceof Error ? error.message : String(error),
    }));
    const response = fail(500, 'Internal server error');
    return withApplicationSecurityHeaders(url.pathname.startsWith('/s/') ? withPrivateNoStore(response) : response, request);
  }
}
