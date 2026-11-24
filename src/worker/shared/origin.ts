import { HttpError } from '../http';
import type { Env } from '../types';

export interface PublicOriginOptions {
  allowLocalHttp?: boolean;
  httpError?: boolean;
}

export function publicOrigin(env: Env, options: PublicOriginOptions = {}): string {
  let url: URL;
  try {
    url = new URL(env.PUBLIC_ORIGIN);
  } catch {
    if (options.httpError) {
      throw new HttpError(500, 'PUBLIC_ORIGIN_INVALID', 'Public origin is invalid');
    }
    throw new Error('PUBLIC_ORIGIN is invalid');
  }

  const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const validProtocol = url.protocol === 'https:' || (Boolean(options.allowLocalHttp) && isLocalHost && url.protocol === 'http:');
  const strictExact = options.allowLocalHttp
    ? true
    : url.origin === env.PUBLIC_ORIGIN && url.pathname === '/' && !url.search && !url.hash;

  if (!validProtocol || !strictExact) {
    if (options.httpError) {
      throw new HttpError(500, 'PUBLIC_ORIGIN_INVALID', 'Public origin is invalid');
    }
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin');
  }

  return url.origin;
}
