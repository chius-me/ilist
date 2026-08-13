import { HttpError } from '../../http';
import type { PikPakCaptchaResponse, PikPakTokenResponse } from './types';

export const PIKPAK_CLIENT_ID = 'YUMx5nI8ZU8Ap8pm';
export const PIKPAK_CLIENT_VERSION = '2.0.0';
export const PIKPAK_PACKAGE_NAME = 'mypikpak.com';
export const PIKPAK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0';
export const PIKPAK_SIGN_IN_URL = 'https://user.mypikpak.com/v1/auth/signin';
export const PIKPAK_TOKEN_URL = 'https://user.mypikpak.com/v1/auth/token';
export const PIKPAK_CAPTCHA_URL = 'https://user.mypikpak.com/v1/shield/captcha/init';

const CAPTCHA_SALTS = [
  'C9qPpZLN8ucRTaTiUMWYS9cQvWOE', '+r6CQVxjzJV6LCV', 'F', 'pFJRC',
  '9WXYIDGrwTCz2OiVlgZa90qpECPD6olt', '/750aCr4lm/Sly/c', 'RB+DT/gZCrbV', '',
  'CyLsf7hdkIRxRm215hl', '7xHvLi2tOYP0Y92b', 'ZGTXXxu8E/MIWaEDB+Sm/', '1UI3',
  'E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO', 'ihtqpG6FMt65+Xk+tWUH2', 'NhXXU9rg4XXdzo7u5o',
];

function rotateLeft(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

/** Small RFC 1321 implementation used only for PikPak's documented client captcha signature. */
function md5(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength & 0xffffffffn), true);
  view.setUint32(paddedLength - 4, Number(bitLength >> 32n), true);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let a = a0; let b = b0; let c = c0; let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number; let word: number; let shift: number;
      if (index < 16) { f = (b & c) | (~b & d); word = index; shift = shifts[index % 4]; }
      else if (index < 32) { f = (d & b) | (~d & c); word = (5 * index + 1) % 16; shift = shifts[4 + index % 4]; }
      else if (index < 48) { f = b ^ c ^ d; word = (3 * index + 5) % 16; shift = shifts[8 + index % 4]; }
      else { f = c ^ (b | ~d); word = (7 * index) % 16; shift = shifts[12 + index % 4]; }
      const next = d;
      d = c; c = b;
      b = (b + rotateLeft((a + f + constants[index] + words[word]) >>> 0, shift)) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((word) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

function captchaSignature(deviceId: string): { timestamp: string; signature: string } {
  const timestamp = String(Date.now());
  let value = `${PIKPAK_CLIENT_ID}${PIKPAK_CLIENT_VERSION}${PIKPAK_PACKAGE_NAME}${deviceId}${timestamp}`;
  for (const salt of CAPTCHA_SALTS) value = md5(value + salt);
  return { timestamp, signature: `1.${value}` };
}

export function generatePikPakDeviceId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function authenticationError(payload: Record<string, unknown> | null): HttpError {
  const verificationUrl = typeof payload?.error_url === 'string' ? payload.error_url : undefined;
  const reason = typeof payload?.error === 'string' ? payload.error : '';
  if (verificationUrl || reason.includes('captcha')) {
    return new HttpError(409, 'PIKPAK_VERIFICATION_REQUIRED', 'PikPak requires interactive verification; complete it in PikPak and retry, or configure a refresh token', verificationUrl ? { verificationUrl } : undefined);
  }
  return new HttpError(401, 'PIKPAK_AUTH_FAILED', 'PikPak authentication failed');
}

export async function requestPikPakCaptcha(
  action: string,
  deviceId: string,
  identity: { username?: string; userId?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ token: string; expiresAt: number; verificationUrl?: string }> {
  const meta: Record<string, string> = {};
  if (action === 'POST:/v1/auth/signin' && identity.username) meta.username = identity.username;
  else {
    const signature = captchaSignature(deviceId);
    meta.captcha_sign = signature.signature;
    meta.timestamp = signature.timestamp;
    meta.client_version = PIKPAK_CLIENT_VERSION;
    meta.package_name = PIKPAK_PACKAGE_NAME;
    if (identity.userId) meta.user_id = identity.userId;
  }
  const response = await fetcher(PIKPAK_CAPTCHA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': PIKPAK_USER_AGENT },
    body: JSON.stringify({ action, client_id: PIKPAK_CLIENT_ID, device_id: deviceId, meta }),
  });
  const payload = await safeJson(response) as PikPakCaptchaResponse | null;
  if (!response.ok || !payload?.captcha_token) throw authenticationError(payload as Record<string, unknown> | null);
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 300;
  return {
    token: payload.captcha_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(payload.url ? { verificationUrl: payload.url } : {}),
  };
}

function validToken(payload: PikPakTokenResponse | null, fallbackRefreshToken?: string): {
  accessToken: string; refreshToken: string; tokenType: string; expiresAt: number; userId?: string;
} {
  if (!payload || typeof payload.access_token !== 'string' || !payload.access_token || typeof payload.expires_in !== 'number') {
    throw new HttpError(502, 'PIKPAK_TOKEN_RESPONSE_INVALID', 'PikPak token response was invalid');
  }
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) throw new HttpError(502, 'PIKPAK_TOKEN_RESPONSE_INVALID', 'PikPak token response was invalid');
  return {
    accessToken: payload.access_token,
    refreshToken,
    tokenType: payload.token_type ?? 'Bearer',
    expiresAt: Date.now() + payload.expires_in * 1000,
    ...(payload.sub ? { userId: payload.sub } : {}),
  };
}

export async function authenticatePikPak(
  username: string,
  password: string,
  deviceId = generatePikPakDeviceId(),
  fetcher: typeof fetch = fetch,
): Promise<{ auth: ReturnType<typeof validToken>; deviceId: string; username: string; captchaToken: string; captchaExpiresAt: number }> {
  const captcha = await requestPikPakCaptcha('POST:/v1/auth/signin', deviceId, { username }, fetcher);
  const response = await fetcher(PIKPAK_SIGN_IN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'user-agent': PIKPAK_USER_AGENT,
      'x-client-id': PIKPAK_CLIENT_ID, 'x-client-version': PIKPAK_CLIENT_VERSION,
      'x-device-id': deviceId, 'x-captcha-token': captcha.token,
    },
    body: JSON.stringify({ username, password, client_id: PIKPAK_CLIENT_ID }),
  });
  const payload = await safeJson(response);
  if (!response.ok) throw authenticationError(payload);
  return {
    auth: validToken(payload as PikPakTokenResponse), deviceId, username,
    captchaToken: captcha.token, captchaExpiresAt: captcha.expiresAt,
  };
}

export async function refreshPikPakToken(
  refreshToken: string,
  deviceId: string,
  fetcher: typeof fetch = fetch,
): Promise<ReturnType<typeof validToken>> {
  const response = await fetcher(PIKPAK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', 'user-agent': PIKPAK_USER_AGENT,
      'x-client-id': PIKPAK_CLIENT_ID, 'x-client-version': PIKPAK_CLIENT_VERSION, 'x-device-id': deviceId,
    },
    body: new URLSearchParams({ client_id: PIKPAK_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const payload = await safeJson(response);
  if (!response.ok) throw new HttpError(401, 'PIKPAK_AUTH_EXPIRED', 'PikPak authentication expired');
  return validToken(payload as PikPakTokenResponse, refreshToken);
}
