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
  trimValues: true,
  processEntities: true,
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

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new S3XmlError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new S3XmlError();
  return parsed;
}

export function parseListObjectsV2Xml(xml: string): S3ListObjectsResult {
  const root = record(parseDocument(xml).ListBucketResult);
  const objects = asArray(root.Contents).map((value): S3ListedObject => {
    const item = record(value);
    return {
      key: requiredText(item, 'Key'),
      lastModified: optionalText(item, 'LastModified'),
      etag: optionalText(item, 'ETag'),
      size: nonNegativeInteger(optionalText(item, 'Size'), 0),
      storageClass: optionalText(item, 'StorageClass'),
    };
  });
  const commonPrefixes = asArray(root.CommonPrefixes).map((value) => requiredText(record(value), 'Prefix'));

  return {
    objects,
    commonPrefixes,
    nextContinuationToken: optionalText(root, 'NextContinuationToken'),
    isTruncated: optionalText(root, 'IsTruncated') === 'true',
    keyCount: nonNegativeInteger(optionalText(root, 'KeyCount'), objects.length),
  };
}

export function parseS3ErrorXml(xml: string): ParsedS3Error {
  const root = record(parseDocument(xml).Error);
  return {
    code: requiredText(root, 'Code'),
    message: requiredText(root, 'Message'),
    resource: optionalText(root, 'Resource'),
    requestId: optionalText(root, 'RequestId'),
  };
}
