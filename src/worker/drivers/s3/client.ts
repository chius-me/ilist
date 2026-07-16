import {
  encodeS3Component,
  encodeS3Path,
  signS3Headers,
  type S3SigningCredentials,
} from './signing';
import type { CompletedUploadPart } from '../types';
import {
  parseCompleteMultipartUploadResponseXml,
  parseCopyObjectResponseXml,
  parseCreateMultipartUploadResponseXml,
  parseListObjectsV2Xml,
  parseS3ErrorXml,
  type S3ListObjectsResult,
} from './xml';

export type S3AddressingStyle = 'path' | 'virtual';

export interface S3ClientOptions {
  endpoint: string;
  region: string;
  bucket: string;
  addressingStyle: S3AddressingStyle;
  credentials: S3SigningCredentials;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ListObjectsV2Options {
  prefix?: string;
  delimiter?: string;
  continuationToken?: string;
  maxKeys?: number;
}

export interface S3RequestOptions {
  headers?: HeadersInit;
}

export interface GetObjectOptions extends S3RequestOptions {
  range?: string;
}

export interface PutObjectOptions extends S3RequestOptions {
  contentType?: string;
}

export interface S3UploadPartOptions {
  signal?: AbortSignal;
}

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  readonly resource: string | null;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    resource: string | null = null,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
    this.resource = resource;
    this.requestId = requestId;
  }

  static async fromResponse(response: Response): Promise<S3Error> {
    const fallback = new S3Error(response.status, `S3_HTTP_${response.status}`, `S3 request failed with status ${response.status}`);
    let xml: string;
    try {
      xml = await response.text();
    } catch {
      return fallback;
    }
    if (!xml.trim()) return fallback;

    try {
      const parsed = parseS3ErrorXml(xml);
      return new S3Error(response.status, parsed.code, parsed.message, parsed.resource, parsed.requestId);
    } catch {
      return fallback;
    }
  }
}

export class S3Client {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly addressingStyle: S3AddressingStyle;
  private readonly credentials: S3SigningCredentials;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(options: S3ClientOptions) {
    this.endpoint = new URL(options.endpoint);
    this.endpoint.search = '';
    this.endpoint.hash = '';
    this.region = options.region;
    this.bucket = options.bucket;
    this.addressingStyle = options.addressingStyle;
    this.credentials = options.credentials;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());

    if (!this.bucket) throw new TypeError('S3 bucket is required');
    if (!this.region) throw new TypeError('S3 region is required');
  }

  async listObjectsV2(options: ListObjectsV2Options = {}): Promise<S3ListObjectsResult> {
    if (options.maxKeys !== undefined && (!Number.isInteger(options.maxKeys) || options.maxKeys < 0 || options.maxKeys > 1000)) {
      throw new RangeError('S3 maxKeys must be an integer from 0 to 1000');
    }

    const query: Array<[string, string]> = [
      ['list-type', '2'],
      ['encoding-type', 'url'],
    ];
    if (options.prefix !== undefined) query.push(['prefix', options.prefix]);
    if (options.delimiter !== undefined) query.push(['delimiter', options.delimiter]);
    if (options.continuationToken !== undefined) query.push(['continuation-token', options.continuationToken]);
    if (options.maxKeys !== undefined) query.push(['max-keys', String(options.maxKeys)]);
    const url = `${this.requestUrl()}?${query
      .map(([name, value]) => `${encodeS3Component(name)}=${encodeS3Component(value)}`)
      .join('&')}`;

    const response = await this.send('GET', url);
    return parseListObjectsV2Xml(await response.text());
  }

  headObject(key: string, options: S3RequestOptions = {}): Promise<Response> {
    return this.send('HEAD', this.requestUrl(key), { headers: options.headers });
  }

  getObject(key: string, options: GetObjectOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.range !== undefined) headers.set('range', options.range);
    return this.send('GET', this.requestUrl(key), { headers });
  }

  putObject(key: string, body: BodyInit | null, options: PutObjectOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.contentType !== undefined) headers.set('content-type', options.contentType);
    return this.send('PUT', this.requestUrl(key), { headers, body });
  }

  async createMultipartUpload(key: string, contentType: string | null): Promise<{ uploadId: string }> {
    const headers = new Headers();
    if (contentType !== null) headers.set('content-type', contentType);
    const response = await this.send('POST', `${this.requestUrl(key)}?uploads`, { headers });
    return parseCreateMultipartUploadResponseXml(await response.text());
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: BodyInit,
    options: S3UploadPartOptions = {},
  ): Promise<{ etag: string }> {
    if (!Number.isInteger(partNumber) || partNumber <= 0) {
      throw new RangeError('S3 multipart part number must be a positive integer');
    }
    const url = `${this.requestUrl(key)}?partNumber=${encodeS3Component(String(partNumber))}&uploadId=${encodeS3Component(uploadId)}`;
    const response = await this.send('PUT', url, { body, signal: options.signal });
    const etag = response.headers.get('etag')?.trim();
    if (!etag) throw new Error('S3 upload part response is missing ETag');
    return { etag };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedUploadPart[]): Promise<Response> {
    const sortedParts = [...parts].sort((left, right) => left.partNumber - right.partNumber);
    const partNumbers = new Set<number>();
    for (const part of sortedParts) {
      if (!Number.isInteger(part.partNumber) || part.partNumber <= 0 || partNumbers.has(part.partNumber)) {
        throw new RangeError('S3 multipart part numbers must be unique positive integers');
      }
      if (!part.etag) throw new TypeError('S3 multipart part ETag is required');
      partNumbers.add(part.partNumber);
    }
    const body = `<CompleteMultipartUpload>${sortedParts.map((part) =>
      `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag!)}</ETag></Part>`
    ).join('')}</CompleteMultipartUpload>`;
    const url = `${this.requestUrl(key)}?uploadId=${encodeS3Component(uploadId)}`;
    const response = await this.send('POST', url, { headers: { 'content-type': 'application/xml' }, body });
    const parsed = parseCompleteMultipartUploadResponseXml(await response.clone().text());
    if (parsed.kind === 'error') {
      const { error } = parsed;
      throw new S3Error(response.status, error.code, error.message, error.resource, error.requestId);
    }
    return response;
  }

  abortMultipartUpload(key: string, uploadId: string): Promise<Response> {
    return this.send('DELETE', `${this.requestUrl(key)}?uploadId=${encodeS3Component(uploadId)}`);
  }

  async copyObject(sourceKey: string, destinationKey: string, options: S3RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('x-amz-copy-source', `/${encodeS3Component(this.bucket)}/${encodeS3Path(sourceKey)}`);
    const response = await this.send('PUT', this.requestUrl(destinationKey), { headers });

    const parsed = parseCopyObjectResponseXml(await response.clone().text());
    if (parsed.kind === 'error') {
      const { error } = parsed;
      throw new S3Error(response.status, error.code, error.message, error.resource, error.requestId);
    }
    return response;
  }

  deleteObject(key: string, options: S3RequestOptions = {}): Promise<Response> {
    return this.send('DELETE', this.requestUrl(key), { headers: options.headers });
  }

  private requestUrl(key?: string): string {
    const url = new URL(this.endpoint.toString());
    const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    const keyPath = key === undefined ? '' : `/${encodeS3Path(key)}`;

    if (this.addressingStyle === 'virtual') {
      url.hostname = `${this.bucket}.${url.hostname}`;
      return `${url.origin}${`${basePath}${keyPath}` || '/'}`;
    }
    return `${url.origin}${basePath}/${encodeS3Component(this.bucket)}${keyPath}`;
  }

  private async send(
    method: string,
    url: string,
    init: { headers?: HeadersInit; body?: BodyInit | null; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers = await signS3Headers({
      url,
      method,
      headers: init.headers,
      region: this.region,
      credentials: this.credentials,
      now: this.now(),
    });
    const response = await this.fetcher(url, { method, headers, body: init.body, signal: init.signal });
    if (!response.ok) throw await S3Error.fromResponse(response);
    return response;
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!);
}

export type { S3ListedObject, S3ListObjectsResult } from './xml';
