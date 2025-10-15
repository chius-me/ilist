const encoder = new TextEncoder();

export interface S3SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignS3RequestOptions {
  request: Request;
  region: string;
  credentials: S3SigningCredentials;
  now?: Date;
  payloadHash?: string;
}

export interface SignS3HeadersOptions {
  url: string;
  method: string;
  headers?: HeadersInit;
  region: string;
  credentials: S3SigningCredentials;
  now?: Date;
  payloadHash?: string;
}

export interface CanonicalS3Request {
  canonicalRequest: string;
  signedHeaders: string;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
}

function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

export function encodeS3Component(value: string): string {
  return [...encoder.encode(value)]
    .map((byte) => (isUnreserved(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

export function encodeS3Path(value: string): string {
  return value
    .split('/')
    .map((segment) => {
      if (segment === '.') return '%2E';
      if (segment === '..') return '%2E%2E';
      return encodeS3Component(segment);
    })
    .join('/');
}

function rawPathname(rawUrl: string): string {
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd === -1) throw new TypeError('S3 request URL must be absolute');
  const authorityStart = schemeEnd + 3;
  const queryStart = rawUrl.indexOf('?', authorityStart);
  const fragmentStart = rawUrl.indexOf('#', authorityStart);
  const pathStart = rawUrl.indexOf('/', authorityStart);
  const firstSuffix = [queryStart, fragmentStart].filter((index) => index !== -1).sort((left, right) => left - right)[0];
  if (pathStart === -1 || (firstSuffix !== undefined && pathStart > firstSuffix)) return '/';
  const pathEnd = [queryStart, fragmentStart]
    .filter((index) => index > pathStart)
    .sort((left, right) => left - right)[0];
  return rawUrl.slice(pathStart, pathEnd);
}

function canonicalUri(rawUrl: string): string {
  return rawPathname(rawUrl)
    .split('/')
    .map((segment) => {
      try {
        return encodeS3Component(decodeURIComponent(segment));
      } catch {
        throw new TypeError('S3 request URL contains an invalid encoded path');
      }
    })
    .join('/');
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError('S3 request URL contains an invalid encoded query');
  }
}

function canonicalQuery(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return '';
  const fragmentStart = rawUrl.indexOf('#', queryStart);
  const rawQuery = rawUrl.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
  if (!rawQuery) return '';

  return rawQuery
    .split('&')
    .map((parameter) => {
      const separator = parameter.indexOf('=');
      const name = separator === -1 ? parameter : parameter.slice(0, separator);
      const value = separator === -1 ? '' : parameter.slice(separator + 1);
      return [encodeS3Component(decodeQueryComponent(name)), encodeS3Component(decodeQueryComponent(value))] as const;
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const left = leftName === rightName ? leftValue : leftName;
      const right = leftName === rightName ? rightValue : rightName;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(rawUrl: string, requestHeaders: Headers): { headers: string; signedHeaders: string } {
  const values = new Map<string, string>();
  for (const [rawName, rawValue] of requestHeaders.entries()) {
    const name = rawName.toLowerCase();
    if (name === 'authorization' || name === 'host') continue;
    values.set(name, rawValue.trim().replace(/\s+/g, ' '));
  }
  values.set('host', new URL(rawUrl).host.toLowerCase());

  const names = [...values.keys()].sort();
  return {
    headers: names.map((name) => `${name}:${values.get(name)}`).join('\n'),
    signedHeaders: names.join(';'),
  };
}

export function canonicalizeS3Request(request: Request, payloadHash: string): CanonicalS3Request {
  return canonicalizeRawS3Request(request.method, request.url, request.headers, payloadHash);
}

function canonicalizeRawS3Request(
  method: string,
  rawUrl: string,
  requestHeaders: Headers,
  payloadHash: string,
): CanonicalS3Request {
  const { headers, signedHeaders } = canonicalHeaders(rawUrl, requestHeaders);
  return {
    canonicalRequest: [
      method.toUpperCase(),
      canonicalUri(rawUrl),
      canonicalQuery(rawUrl),
      headers,
      '',
      signedHeaders,
      payloadHash,
    ].join('\n'),
    signedHeaders,
  };
}

function amzDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new TypeError('S3 signing date is invalid');
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export async function signS3Request(options: SignS3RequestOptions): Promise<Request> {
  const headers = await signS3Headers({
    url: options.request.url,
    method: options.request.method,
    headers: options.request.headers,
    region: options.region,
    credentials: options.credentials,
    now: options.now,
    payloadHash: options.payloadHash,
  });
  return new Request(options.request, { headers });
}

export async function signS3Headers(options: SignS3HeadersOptions): Promise<Headers> {
  const { credentials, region } = options;
  const date = amzDate(options.now ?? new Date());
  const dateStamp = date.slice(0, 8);
  const headers = new Headers(options.headers);
  const payloadHash = options.payloadHash ?? headers.get('x-amz-content-sha256') ?? 'UNSIGNED-PAYLOAD';

  headers.delete('authorization');
  headers.set('x-amz-content-sha256', payloadHash);
  headers.set('x-amz-date', date);
  if (credentials.sessionToken) headers.set('x-amz-security-token', credentials.sessionToken);
  else headers.delete('x-amz-security-token');

  const { canonicalRequest, signedHeaders } = canonicalizeRawS3Request(options.method, options.url, headers, payloadHash);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, await sha256(canonicalRequest)].join('\n');

  const dateKey = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 's3');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = toHex(await hmac(signingKey, stringToSign));

  headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},` +
      `SignedHeaders=${signedHeaders},Signature=${signature}`,
  );
  return headers;
}
