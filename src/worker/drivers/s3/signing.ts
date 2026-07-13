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
  return value.split('/').map(encodeS3Component).join('/');
}

function canonicalUri(url: URL): string {
  return url.pathname
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

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [encodeS3Component(name), encodeS3Component(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const left = leftName === rightName ? leftValue : leftName;
      const right = leftName === rightName ? rightValue : rightName;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(request: Request): { headers: string; signedHeaders: string } {
  const values = new Map<string, string>();
  for (const [rawName, rawValue] of request.headers.entries()) {
    const name = rawName.toLowerCase();
    if (name === 'authorization' || name === 'host') continue;
    values.set(name, rawValue.trim().replace(/\s+/g, ' '));
  }
  values.set('host', new URL(request.url).host.toLowerCase());

  const names = [...values.keys()].sort();
  return {
    headers: names.map((name) => `${name}:${values.get(name)}`).join('\n'),
    signedHeaders: names.join(';'),
  };
}

export function canonicalizeS3Request(request: Request, payloadHash: string): CanonicalS3Request {
  const url = new URL(request.url);
  const { headers, signedHeaders } = canonicalHeaders(request);
  return {
    canonicalRequest: [
      request.method.toUpperCase(),
      canonicalUri(url),
      canonicalQuery(url),
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
  const { credentials, region } = options;
  const date = amzDate(options.now ?? new Date());
  const dateStamp = date.slice(0, 8);
  const headers = new Headers(options.request.headers);
  const payloadHash = options.payloadHash ?? headers.get('x-amz-content-sha256') ?? 'UNSIGNED-PAYLOAD';

  headers.delete('authorization');
  headers.set('x-amz-content-sha256', payloadHash);
  headers.set('x-amz-date', date);
  if (credentials.sessionToken) headers.set('x-amz-security-token', credentials.sessionToken);
  else headers.delete('x-amz-security-token');

  const signedRequest = new Request(options.request, { headers });
  const { canonicalRequest, signedHeaders } = canonicalizeS3Request(signedRequest, payloadHash);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, await sha256(canonicalRequest)].join('\n');

  const dateKey = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 's3');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = toHex(await hmac(signingKey, stringToSign));

  signedRequest.headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},` +
      `SignedHeaders=${signedHeaders},Signature=${signature}`,
  );
  return signedRequest;
}
