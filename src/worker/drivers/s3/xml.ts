import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface S3ListedObject {
  key: string;
  lastModified: string | null;
  etag: string | null;
  size: number;
  storageClass: string | null;
}

export interface S3ListObjectsResult {
  objects: S3ListedObject[];
  commonPrefixes: string[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
  keyCount: number;
}

export interface ParsedS3Error {
  code: string;
  message: string;
  resource: string | null;
  requestId: string | null;
}

export type ParsedCopyObjectResponse =
  | { kind: 'result'; etag: string; lastModified: string }
  | { kind: 'error'; error: ParsedS3Error };

export interface ParsedCreateMultipartUploadResponse {
  uploadId: string;
}

export type ParsedCompleteMultipartUploadResponse =
  | { kind: 'result'; etag: string }
  | { kind: 'error'; error: ParsedS3Error };

export class S3XmlError extends Error {
  constructor() {
    super('Invalid S3 XML response');
    this.name = 'S3XmlError';
  }
}

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  removeNSPrefix: true,
});

function parseDocument(xml: string): XmlRecord {
  if (!xml.trim() || XMLValidator.validate(xml) !== true) throw new S3XmlError();
  const parsed: unknown = parser.parse(xml);
  if (!isRecord(parsed)) throw new S3XmlError();
  return parsed;
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): XmlRecord {
  if (!isRecord(value)) throw new S3XmlError();
  return value;
}

function optionalText(parent: XmlRecord, key: string): string | null {
  const value = parent[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new S3XmlError();
  return value;
}

function requiredText(parent: XmlRecord, key: string): string {
  const value = optionalText(parent, key);
  if (value === null) throw new S3XmlError();
  return value;
}

function requiredTrimmedText(parent: XmlRecord, key: string): string {
  const value = requiredText(parent, key).trim();
  if (!value) throw new S3XmlError();
  return value;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const scalar = value.trim();
  if (!/^\d+$/.test(scalar)) throw new S3XmlError();
  const parsed = Number(scalar);
  if (!Number.isSafeInteger(parsed)) throw new S3XmlError();
  return parsed;
}

function decodeUrlEncodedField(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new S3XmlError();
  }
}

export function parseListObjectsV2Xml(xml: string): S3ListObjectsResult {
  const root = record(parseDocument(xml).ListBucketResult);
  const encodingType = optionalText(root, 'EncodingType')?.trim() ?? null;
  if (encodingType !== null && encodingType !== 'url') throw new S3XmlError();
  const decodeField = encodingType === 'url' ? decodeUrlEncodedField : (value: string) => value;
  const objects = asArray(root.Contents).map((value): S3ListedObject => {
    const item = record(value);
    return {
      key: decodeField(requiredText(item, 'Key')),
      lastModified: optionalText(item, 'LastModified'),
      etag: optionalText(item, 'ETag'),
      size: nonNegativeInteger(optionalText(item, 'Size'), 0),
      storageClass: optionalText(item, 'StorageClass'),
    };
  });
  const commonPrefixes = asArray(root.CommonPrefixes).map((value) => decodeField(requiredText(record(value), 'Prefix')));
  const isTruncated = optionalText(root, 'IsTruncated')?.trim() ?? 'false';
  if (isTruncated !== 'true' && isTruncated !== 'false') throw new S3XmlError();

  return {
    objects,
    commonPrefixes,
    nextContinuationToken: optionalText(root, 'NextContinuationToken'),
    isTruncated: isTruncated === 'true',
    keyCount: nonNegativeInteger(optionalText(root, 'KeyCount'), objects.length),
  };
}

export function parseS3ErrorXml(xml: string): ParsedS3Error {
  return parseS3ErrorRoot(record(parseDocument(xml).Error));
}

function parseS3ErrorRoot(root: XmlRecord): ParsedS3Error {
  return {
    code: requiredTrimmedText(root, 'Code'),
    message: requiredTrimmedText(root, 'Message'),
    resource: optionalText(root, 'Resource')?.trim() ?? null,
    requestId: optionalText(root, 'RequestId')?.trim() ?? null,
  };
}

export function parseCopyObjectResponseXml(xml: string): ParsedCopyObjectResponse {
  const document = parseDocument(xml);
  if (document.Error !== undefined) {
    return { kind: 'error', error: parseS3ErrorRoot(record(document.Error)) };
  }

  const root = record(document.CopyObjectResult);
  const etag = requiredTrimmedText(root, 'ETag');
  const lastModified = requiredTrimmedText(root, 'LastModified');
  return { kind: 'result', etag, lastModified };
}

export function parseCreateMultipartUploadResponseXml(xml: string): ParsedCreateMultipartUploadResponse {
  const root = record(parseDocument(xml).InitiateMultipartUploadResult);
  return { uploadId: requiredTrimmedText(root, 'UploadId') };
}

export function parseCompleteMultipartUploadResponseXml(xml: string): ParsedCompleteMultipartUploadResponse {
  const document = parseDocument(xml);
  if (document.Error !== undefined) {
    return { kind: 'error', error: parseS3ErrorRoot(record(document.Error)) };
  }

  const root = record(document.CompleteMultipartUploadResult);
  return { kind: 'result', etag: requiredTrimmedText(root, 'ETag') };
}
