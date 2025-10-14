import {
  encodeS3Component,
  encodeS3Path,
  signS3Request,
  type S3SigningCredentials,
} from './signing';
import { parseListObjectsV2Xml, parseS3ErrorXml, type ParsedS3Error, type S3ListObjectsResult } from './xml';

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

    const url = this.requestUrl();
    url.searchParams.set('list-type', '2');
    if (options.prefix !== undefined) url.searchParams.set('prefix', options.prefix);
    if (options.delimiter !== undefined) url.searchParams.set('delimiter', options.delimiter);
    if (options.continuationToken !== undefined) url.searchParams.set('continuation-token', options.continuationToken);
    if (options.maxKeys !== undefined) url.searchParams.set('max-keys', String(options.maxKeys));

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

  async copyObject(sourceKey: string, destinationKey: string, options: S3RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('x-amz-copy-source', `/${encodeS3Component(this.bucket)}/${encodeS3Path(sourceKey)}`);
    const response = await this.send('PUT', this.requestUrl(destinationKey), { headers });

    let parsedError: ParsedS3Error;
    try {
      parsedError = parseS3ErrorXml(await response.clone().text());
    } catch {
      return response;
    }
    throw new S3Error(response.status, parsedError.code, parsedError.message, parsedError.resource, parsedError.requestId);
  }

  deleteObject(key: string, options: S3RequestOptions = {}): Promise<Response> {
    return this.send('DELETE', this.requestUrl(key), { headers: options.headers });
  }

  private requestUrl(key?: string): URL {
    const url = new URL(this.endpoint.toString());
    const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    const keyPath = key === undefined ? '' : `/${encodeS3Path(key)}`;

    if (this.addressingStyle === 'virtual') {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = `${basePath}${keyPath}` || '/';
    } else {
      url.pathname = `${basePath}/${encodeS3Component(this.bucket)}${keyPath}`;
    }
    return url;
  }

  private async send(
    method: string,
    url: URL,
    init: { headers?: HeadersInit; body?: BodyInit | null } = {},
  ): Promise<Response> {
    const request = new Request(url, {
      method,
      headers: init.headers,
      body: init.body,
    });
    const signed = await signS3Request({
      request,
      region: this.region,
      credentials: this.credentials,
      now: this.now(),
    });
    const response = await this.fetcher(signed);
    if (!response.ok) throw await S3Error.fromResponse(response);
    return response;
  }
}

export type { S3ListedObject, S3ListObjectsResult } from './xml';
