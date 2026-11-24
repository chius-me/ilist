import { patchCredentials } from './credentials';
import {
  consumeDropboxOAuthState,
  createDropboxAuthorization,
  DROPBOX_SCOPES,
  dropboxCallbackUrl,
  requestDropboxTokens,
} from './drivers/dropbox/oauth';
import {
  consumeGoogleOAuthState,
  createGoogleAuthorization,
  GOOGLE_DRIVE_SCOPES,
  googleDriveCallbackUrl,
  requestGoogleTokens,
} from './drivers/google/oauth';
import {
  consumeOneDriveOAuthState,
  createOneDriveAuthorization,
  ONEDRIVE_SCOPES,
  oneDriveCallbackUrl,
  requestOneDriveTokens,
} from './drivers/onedrive/oauth';
import { fail, HttpError, ok, readJson } from './http';
import { getMount } from './mounts';
import { isRecord } from './shared/encoding';
import { publicOrigin } from './shared/origin';
import type { Env } from './types';

function assertConfiguredOrigin(request: Request, env: Env): void {
  if (new URL(request.url).origin !== publicOrigin(env)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }
}

function methodNotAllowed(): Response {
  return fail(405, 'Method not allowed');
}

async function readStartMountId(request: Request, url: URL): Promise<string> {
  const queryId = url.searchParams.get('mountId');
  if (queryId) return queryId;
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return '';
  const body = await readJson<unknown>(request);
  return isRecord(body) && typeof body.mountId === 'string' ? body.mountId : '';
}

export async function handleOAuthRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/admin/oauth/dropbox/start') {
    if (request.method !== 'POST') return methodNotAllowed();
    assertConfiguredOrigin(request, env);
    const mountId = await readStartMountId(request, url);
    const mount = await getMount(env.DB, mountId);
    if (!mount || mount.driverType !== 'dropbox') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Dropbox mount not found');
    return ok({ url: await createDropboxAuthorization(env, mount.id) });
  }

  if (url.pathname === '/api/admin/oauth/dropbox/callback') {
    if (request.method !== 'GET') return methodNotAllowed();
    assertConfiguredOrigin(request, env);
    const pending = await consumeDropboxOAuthState(env, url.searchParams.get('state') ?? '');
    if (url.searchParams.has('error')) {
      return Response.redirect(`${publicOrigin(env)}/admin/storages?dropbox=error`, 302);
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) throw new HttpError(400, 'OAUTH_CODE_MISSING', 'OAuth authorization code is missing');
    const mount = await getMount(env.DB, pending.mountId);
    if (!mount || mount.driverType !== 'dropbox') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Dropbox mount not found');
    const token = await requestDropboxTokens(env, mount.id, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: dropboxCallbackUrl(env),
      code_verifier: pending.verifier,
    });
    if (!token.refreshToken) throw new HttpError(502, 'DROPBOX_TOKEN_EXCHANGE_FAILED', 'Dropbox did not return a refresh token');
    await patchCredentials(env, mount.id, { auth: {
      accessToken: token.accessToken, refreshToken: token.refreshToken, tokenType: token.tokenType,
      expiresAt: Date.now() + token.expiresIn * 1000, scope: token.scope ?? DROPBOX_SCOPES,
    }, accessToken: null, refreshToken: null, tokenType: null, expiresAt: null, scope: null });
    return Response.redirect(`${publicOrigin(env)}/admin/storages?dropbox=connected`, 302);
  }

  if (url.pathname === '/api/admin/oauth/google/start') {
    if (request.method !== 'POST') return methodNotAllowed();
    assertConfiguredOrigin(request, env);
    const mountId = await readStartMountId(request, url);
    const mount = await getMount(env.DB, mountId);
    if (!mount || mount.driverType !== 'google') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Google Drive mount not found');
    return ok({ url: await createGoogleAuthorization(env, mount.id) });
  }

  if (url.pathname === '/api/admin/oauth/google/callback') {
    if (request.method !== 'GET') return methodNotAllowed();
    assertConfiguredOrigin(request, env);
    const pending = await consumeGoogleOAuthState(env, url.searchParams.get('state') ?? '');
    if (url.searchParams.has('error')) {
      return Response.redirect(`${publicOrigin(env)}/admin/storages?google=error`, 302);
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) throw new HttpError(400, 'OAUTH_CODE_MISSING', 'OAuth authorization code is missing');
    const mount = await getMount(env.DB, pending.mountId);
    if (!mount || mount.driverType !== 'google') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'Google Drive mount not found');
    const token = await requestGoogleTokens(env, mount.id, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: googleDriveCallbackUrl(env),
      code_verifier: pending.verifier,
    });
    if (!token.refreshToken) throw new HttpError(502, 'GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google did not return a refresh token');
    await patchCredentials(env, mount.id, { auth: {
      accessToken: token.accessToken, refreshToken: token.refreshToken, tokenType: token.tokenType,
      expiresAt: Date.now() + token.expiresIn * 1000, scope: token.scope ?? GOOGLE_DRIVE_SCOPES,
    }, accessToken: null, refreshToken: null, tokenType: null, expiresAt: null, scope: null });
    return Response.redirect(`${publicOrigin(env)}/admin/storages?google=connected`, 302);
  }

  if (url.pathname === '/api/admin/oauth/onedrive/start') {
    if (request.method !== 'POST') return methodNotAllowed();
    assertConfiguredOrigin(request, env);
    const mountId = await readStartMountId(request, url);
    const mount = await getMount(env.DB, mountId);
    if (!mount || mount.driverType !== 'onedrive') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'OneDrive mount not found');
    return ok({ url: await createOneDriveAuthorization(env, mount.id) });
  }

  if (url.pathname === '/api/admin/oauth/onedrive/callback') {
    if (request.method !== 'GET') return methodNotAllowed();
    assertConfiguredOrigin(request, env);
    const state = url.searchParams.get('state') ?? '';
    const pending = await consumeOneDriveOAuthState(env, state);
    if (url.searchParams.has('error')) {
      return Response.redirect(`${publicOrigin(env)}/admin/storages?onedrive=error`, 302);
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) throw new HttpError(400, 'OAUTH_CODE_MISSING', 'OAuth authorization code is missing');
    const mount = await getMount(env.DB, pending.mountId);
    if (!mount || mount.driverType !== 'onedrive') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'OneDrive mount not found');
    const token = await requestOneDriveTokens(env, mount.id, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: oneDriveCallbackUrl(env),
      code_verifier: pending.verifier,
      scope: ONEDRIVE_SCOPES,
    });
    if (!token.refreshToken) throw new HttpError(502, 'ONEDRIVE_TOKEN_EXCHANGE_FAILED', 'Microsoft did not return a refresh token');
    await patchCredentials(env, mount.id, { auth: {
      accessToken: token.accessToken, refreshToken: token.refreshToken, tokenType: token.tokenType,
      expiresAt: Date.now() + token.expiresIn * 1000, scope: token.scope ?? ONEDRIVE_SCOPES,
    }, accessToken: null, refreshToken: null, tokenType: null, expiresAt: null, scope: null });
    return Response.redirect(`${publicOrigin(env)}/admin/storages?onedrive=connected`, 302);
  }
  return null;
}
