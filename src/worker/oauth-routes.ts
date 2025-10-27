import { putCredentials } from './credentials';
import {
  consumeOneDriveOAuthState,
  createOneDriveAuthorization,
  ONEDRIVE_SCOPES,
  oneDriveCallbackUrl,
  publicOrigin,
  requestOneDriveTokens,
} from './drivers/onedrive/oauth';
import { HttpError } from './http';
import { getMount } from './mounts';
import type { Env } from './types';

function assertConfiguredOrigin(request: Request, env: Env): void {
  if (new URL(request.url).origin !== publicOrigin(env)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }
}

export async function handleOAuthRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/admin/oauth/onedrive/start') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    assertConfiguredOrigin(request, env);
    const mountId = url.searchParams.get('mountId') ?? '';
    const mount = await getMount(env.DB, mountId);
    if (!mount || mount.driverType !== 'onedrive') throw new HttpError(404, 'MOUNT_NOT_FOUND', 'OneDrive mount not found');
    return Response.redirect(await createOneDriveAuthorization(env, mount.id), 302);
  }

  if (url.pathname === '/api/admin/oauth/onedrive/callback') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
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
    const token = await requestOneDriveTokens(env, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: oneDriveCallbackUrl(env),
      code_verifier: pending.verifier,
      scope: ONEDRIVE_SCOPES,
    });
    if (!token.refreshToken) throw new HttpError(502, 'ONEDRIVE_TOKEN_EXCHANGE_FAILED', 'Microsoft did not return a refresh token');
    await putCredentials(env, mount.id, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: token.tokenType,
      expiresAt: Date.now() + token.expiresIn * 1000,
      scope: token.scope ?? ONEDRIVE_SCOPES,
    });
    return Response.redirect(`${publicOrigin(env)}/admin/storages?onedrive=connected`, 302);
  }
  return null;
}
