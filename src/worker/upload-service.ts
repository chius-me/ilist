import { createDriver } from './drivers/registry';
import { S3Error } from './drivers/s3/client';
import {
  LARGE_UPLOAD_THRESHOLD_BYTES,
  UPLOAD_PART_SIZE_BYTES,
  requireResumableUploadAdapter,
  type ProviderUploadSession,
  type StorageDriver,
  type StorageItem,
} from './drivers/types';
import { validateEntryName } from './entry-domain';
import { externalEntry, resolveExternalEntry } from './external-entries';
import { HttpError } from './http';
import { getMount } from './mounts';
import {
  claimCompletion,
  claimUploadPart,
  completeUploadSessionRecord,
  createUploadSessionRecord,
  getOwnedUploadSession,
  listExpiredUploadSessions,
  markUploadSessionAborted,
  recordUploadPart,
  releaseCompletionClaim,
  releaseUploadPartClaim,
  type UploadSessionRecord,
} from './upload-session-store';
import type { Env, Mount, MountEntry, UploadSessionStatus } from './types';

const PART_CLAIM_DURATION_MS = 5 * 60_000;
const COMPLETION_CLAIM_DURATION_MS = 5 * 60_000;
const DEFAULT_CLEANUP_LIMIT = 10;

export interface CreateUploadSessionBody {
  parentId: string;
  name: string;
  size: number;
  contentType?: string | null;
}

export interface UploadPartView {
  partNumber: number;
  size: number;
}

export interface UploadSessionView {
  id: string;
  kind: 'multipart';
  partSize: number;
  size: number;
  uploadedParts: UploadPartView[];
  expiresAt: string;
  status: UploadSessionStatus;
}

interface SessionDriver {
  mount: Mount;
  driver: StorageDriver & { resumableUpload: NonNullable<StorageDriver['resumableUpload']> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uploadPartInvalid(message: string): HttpError {
  return new HttpError(400, 'UPLOAD_PART_INVALID', message);
}

function uploadUnsupported(): HttpError {
  return new HttpError(400, 'UPLOAD_SESSION_UNSUPPORTED', 'Resumable upload is not supported for this folder');
}

function uploadNotFound(): HttpError {
  return new HttpError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session was not found');
}

function uploadExpired(): HttpError {
  return new HttpError(410, 'UPLOAD_SESSION_EXPIRED', 'Upload session has expired');
}

function uploadBusy(): HttpError {
  return new HttpError(409, 'UPLOAD_PART_BUSY', 'Upload session is processing another request');
}

interface SafeProviderError {
  status: number;
  message: string;
  retryable?: boolean;
}

const SAFE_PROVIDER_ERRORS: Record<string, SafeProviderError> = {
  ONEDRIVE_AUTH_FAILED: { status: 401, message: 'OneDrive authentication failed' },
  ONEDRIVE_ACCESS_DENIED: { status: 403, message: 'OneDrive access was denied' },
  ONEDRIVE_RATE_LIMITED: { status: 503, message: 'OneDrive is temporarily rate limited', retryable: true },
  ONEDRIVE_UPSTREAM_FAILED: { status: 502, message: 'OneDrive request failed' },
  ONEDRIVE_UPLOAD_SESSION_NOT_FOUND: { status: 404, message: 'OneDrive upload session was not found' },
  ONEDRIVE_UPLOAD_SESSION_CONFLICT: {
    status: 409,
    message: 'OneDrive upload session conflicts with the current file',
  },
  ONEDRIVE_UPLOAD_SESSION_INVALID_RANGE: { status: 409, message: 'OneDrive upload part range is invalid' },
  ONEDRIVE_UPLOAD_SESSION_RATE_LIMITED: {
    status: 503,
    message: 'OneDrive upload session is temporarily rate limited',
    retryable: true,
  },
  ONEDRIVE_UPLOAD_SESSION_FAILED: { status: 502, message: 'OneDrive upload session request failed' },
  ONEDRIVE_UPLOAD_SESSION_INVALID: { status: 502, message: 'OneDrive upload session response was invalid' },
  ONEDRIVE_UPLOAD_SESSION_PROOF_INVALID: { status: 400, message: 'OneDrive upload session proof is invalid' },
  STORAGE_ITEM_NOT_FOUND: { status: 404, message: 'Storage item was not found' },
  STORAGE_CONFLICT: { status: 409, message: 'Storage item conflicts with an existing item' },
  INVALID_ENTRY_NAME: { status: 400, message: 'Storage item name is invalid' },
  INVALID_UPLOAD_PART_SIZE: { status: 400, message: 'Upload part size is invalid' },
  INVALID_UPLOAD_CONTENT_TYPE: { status: 400, message: 'Upload content type is invalid' },
  UPLOAD_INCOMPLETE: { status: 409, message: 'Upload session has not completed' },
};

function retryAfterDetails(value: unknown): { retryAfter: number } | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.retryAfter;
  const retryAfter = typeof candidate === 'string' && /^\d+$/.test(candidate)
    ? Number(candidate)
    : candidate;
  return typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 0
    ? { retryAfter }
    : undefined;
}

function normalizeProviderError(error: unknown): HttpError {
  if (error instanceof S3Error) {
    const code = error.code.toLowerCase();
    const rateLimited = error.status === 429 || [
      'slowdown',
      'throttling',
      'throttlingexception',
      'toomanyrequests',
      'toomanyrequestsexception',
    ].includes(code);
    const retryable = error.status === 408 || error.status === 503 || [
      'requesttimeout',
      'requesttimeoutexception',
      'serviceunavailable',
    ].includes(code);
    if (rateLimited || retryable) {
      const details = retryAfterDetails({ retryAfter: error.retryAfterSeconds });
      return new HttpError(
        503,
        rateLimited ? 'UPLOAD_PROVIDER_RATE_LIMITED' : 'UPLOAD_PROVIDER_RETRYABLE',
        rateLimited
          ? 'Storage provider is temporarily rate limited'
          : 'Storage provider upload can be retried',
        details,
      );
    }
  }
  if (error instanceof HttpError) {
    const safe = SAFE_PROVIDER_ERRORS[error.code];
    if (safe) {
      return new HttpError(
        safe.status,
        error.code,
        safe.message,
        safe.retryable ? retryAfterDetails(error.details) : undefined,
      );
    }
  }
  return new HttpError(502, 'UPLOAD_PROVIDER_FAILED', 'Storage provider upload failed');
}

function uploadStatePersistFailed(): HttpError {
  return new HttpError(503, 'UPLOAD_STATE_PERSIST_FAILED', 'Upload state could not be persisted');
}

function expirationIso(expiresAt: number): string {
  try {
    return new Date(expiresAt).toISOString();
  } catch {
    throw new HttpError(502, 'UPLOAD_PROVIDER_INVALID', 'Storage provider returned an invalid upload session');
  }
}

function toSessionView(record: UploadSessionRecord): UploadSessionView {
  return {
    id: record.id,
    kind: 'multipart',
    partSize: record.partSize,
    size: record.size,
    uploadedParts: record.parts.map(({ partNumber, size }) => ({ partNumber, size })),
    expiresAt: expirationIso(record.expiresAt),
    status: record.status,
  };
}

function isExpired(record: UploadSessionRecord, now = Date.now()): boolean {
  return (record.status === 'active' || record.status === 'completing') && record.expiresAt <= now;
}

function requireCurrent(record: UploadSessionRecord, now = Date.now()): void {
  if (isExpired(record, now)) throw uploadExpired();
}

async function ownedSession(env: Env, ownerSessionId: string, id: string): Promise<UploadSessionRecord> {
  const record = await getOwnedUploadSession(env, ownerSessionId, id);
  if (!record) throw uploadNotFound();
  return record;
}

async function sessionDriver(env: Env, record: UploadSessionRecord): Promise<SessionDriver> {
  const mount = await getMount(env.DB, record.mountId);
  if (!mount || (mount.driverType !== 'onedrive' && mount.driverType !== 's3')) throw uploadUnsupported();
  const driver = await createDriver(env, mount);
  if (!requireResumableUploadAdapter(driver)) throw uploadUnsupported();
  return { mount, driver };
}

function validateCreateInput(input: unknown): {
  parentId: string;
  name: string;
  size: number;
  contentType: string | null;
} {
  if (!isRecord(input) || Object.prototype.hasOwnProperty.call(input, 'partSize')) {
    throw uploadPartInvalid('Upload session input is invalid');
  }
  if (
    typeof input.parentId !== 'string'
    || typeof input.name !== 'string'
    || typeof input.size !== 'number'
    || !Number.isSafeInteger(input.size)
    || input.size < LARGE_UPLOAD_THRESHOLD_BYTES
    || (input.contentType !== undefined && input.contentType !== null && typeof input.contentType !== 'string')
  ) {
    throw uploadPartInvalid('Upload session input is invalid');
  }
  return {
    parentId: input.parentId,
    name: validateEntryName(input.name),
    size: input.size,
    contentType: input.contentType ?? null,
  };
}

function validProviderSession(value: ProviderUploadSession): boolean {
  return (
    isRecord(value)
    && isRecord(value.state)
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > Date.now()
    && value.expiresAt <= 8_640_000_000_000_000
  );
}

async function bestEffortAbort(
  driver: StorageDriver & { resumableUpload: NonNullable<StorageDriver['resumableUpload']> },
  state: Record<string, unknown>,
): Promise<void> {
  try {
    await driver.resumableUpload.abort(state);
  } catch {
    // Expiration and provider lifecycle policies remain the cleanup backstop.
  }
}

export async function createResumableUpload(
  env: Env,
  ownerSessionId: string,
  input: CreateUploadSessionBody,
): Promise<UploadSessionView> {
  try {
    await cleanupExpiredUploads(env, DEFAULT_CLEANUP_LIMIT);
  } catch {
    // Cleanup is opportunistic and must not block a new upload.
  }

  const body = validateCreateInput(input);
  const external = await resolveExternalEntry(env, body.parentId, true);
  if (
    !external
    || external.item.kind !== 'folder'
    || (external.mount.driverType !== 'onedrive' && external.mount.driverType !== 's3')
    || !requireResumableUploadAdapter(external.driver)
  ) {
    throw uploadUnsupported();
  }

  let providerSession: ProviderUploadSession;
  try {
    providerSession = await external.driver.resumableUpload.create({
      parentId: external.identity.itemId,
      name: body.name,
      size: body.size,
      contentType: body.contentType,
      partSize: UPLOAD_PART_SIZE_BYTES,
    });
  } catch (error) {
    throw normalizeProviderError(error);
  }

  if (!validProviderSession(providerSession)) {
    if (isRecord(providerSession) && isRecord(providerSession.state)) {
      await bestEffortAbort(external.driver, providerSession.state);
    }
    throw new HttpError(502, 'UPLOAD_PROVIDER_INVALID', 'Storage provider returned an invalid upload session');
  }

  try {
    const record = await createUploadSessionRecord(env, ownerSessionId, {
      mountId: external.mount.id,
      parentItemId: external.identity.itemId,
      name: body.name,
      size: body.size,
      contentType: body.contentType,
      partSize: UPLOAD_PART_SIZE_BYTES,
      providerState: providerSession.state,
      expiresAt: providerSession.expiresAt,
    });
    return toSessionView(record);
  } catch (error) {
    await bestEffortAbort(external.driver, providerSession.state);
    throw uploadStatePersistFailed();
  }
}

export async function getResumableUpload(
  env: Env,
  ownerSessionId: string,
  id: string,
): Promise<UploadSessionView> {
  const record = await ownedSession(env, ownerSessionId, id);
  requireCurrent(record);
  return toSessionView(record);
}

function expectedPart(record: UploadSessionRecord, partNumber: number): { offset: number; size: number } {
  const partCount = Math.ceil(record.size / record.partSize);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw uploadPartInvalid('Upload part number is invalid');
  }
  const offset = (partNumber - 1) * record.partSize;
  return { offset, size: Math.min(record.partSize, record.size - offset) };
}

function requirePartRequest(request: Request, expectedSize: number): void {
  const contentLength = request.headers.get('content-length');
  if (!contentLength || !/^(0|[1-9][0-9]*)$/.test(contentLength)) {
    throw uploadPartInvalid('Upload part Content-Length is missing or invalid');
  }
  const parsedLength = Number(contentLength);
  if (!Number.isSafeInteger(parsedLength) || parsedLength !== expectedSize) {
    throw uploadPartInvalid('Upload part Content-Length does not match the expected size');
  }
  if (!request.body) throw uploadPartInvalid('Upload part body is missing');
}

function recordedPart(record: UploadSessionRecord, partNumber: number, expectedSize: number): UploadPartView | null {
  const part = record.parts.find((candidate) => candidate.partNumber === partNumber);
  if (!part) return null;
  if (part.size !== expectedSize) throw uploadPartInvalid('Recorded upload part size is invalid');
  return { partNumber: part.partNumber, size: part.size };
}

function validProviderPart(
  value: unknown,
  partNumber: number,
  expectedSize: number,
): value is Awaited<ReturnType<NonNullable<StorageDriver['resumableUpload']>['uploadPart']>> {
  if (!isRecord(value) || !isRecord(value.part)) return false;
  const part = value.part;
  return (
    part.partNumber === partNumber
    && part.size === expectedSize
    && (part.etag === null || typeof part.etag === 'string')
    && (value.state === undefined || isRecord(value.state))
  );
}

export async function uploadResumablePart(
  env: Env,
  ownerSessionId: string,
  id: string,
  partNumber: number,
  request: Request,
): Promise<UploadPartView> {
  const initial = await ownedSession(env, ownerSessionId, id);
  requireCurrent(initial);
  const expected = expectedPart(initial, partNumber);
  requirePartRequest(request, expected.size);
  const duplicate = recordedPart(initial, partNumber, expected.size);
  if (duplicate && initial.status !== 'aborted') return duplicate;
  if (initial.status !== 'active') throw uploadBusy();

  const { driver } = await sessionDriver(env, initial);
  const now = Date.now();
  const claimExpiresAt = now + PART_CLAIM_DURATION_MS;
  const claimed = await claimUploadPart(env, ownerSessionId, id, partNumber, claimExpiresAt, now);
  if (!claimed) {
    const current = await ownedSession(env, ownerSessionId, id);
    requireCurrent(current, now);
    const racedDuplicate = recordedPart(current, partNumber, expected.size);
    if (racedDuplicate) return racedDuplicate;
    throw uploadBusy();
  }

  let result: Awaited<ReturnType<NonNullable<StorageDriver['resumableUpload']>['uploadPart']>>;
  try {
    result = await driver.resumableUpload.uploadPart({
      state: claimed.providerState,
      partNumber,
      offset: expected.offset,
      totalSize: claimed.size,
      body: request.body!,
      size: expected.size,
      signal: request.signal,
    });
  } catch (error) {
    try {
      await releaseUploadPartClaim(env, ownerSessionId, id, partNumber, claimExpiresAt);
    } catch {
      // Claim expiry permits a later retry even when best-effort release fails.
    }
    throw normalizeProviderError(error);
  }
  if (!validProviderPart(result, partNumber, expected.size)) {
    await releaseUploadPartClaim(env, ownerSessionId, id, partNumber, claimExpiresAt).catch(() => undefined);
    throw new HttpError(502, 'UPLOAD_PROVIDER_INVALID', 'Storage provider returned an invalid upload part');
  }

  let updated: UploadSessionRecord | null;
  try {
    updated = await recordUploadPart(env, ownerSessionId, id, {
      claimExpiresAt,
      part: result.part,
      providerState: result.state ?? claimed.providerState,
      ...(result.completedItem ? { completedItem: result.completedItem } : {}),
    });
  } catch {
    await releaseUploadPartClaim(env, ownerSessionId, id, partNumber, claimExpiresAt).catch(() => undefined);
    throw uploadStatePersistFailed();
  }
  if (!updated) throw uploadBusy();
  const stored = recordedPart(updated, partNumber, expected.size);
  if (!stored) throw uploadBusy();
  return stored;
}

function requireCompleteParts(record: UploadSessionRecord): void {
  const expectedCount = Math.ceil(record.size / record.partSize);
  if (record.parts.length !== expectedCount) {
    throw new HttpError(409, 'UPLOAD_INCOMPLETE', 'Upload session does not contain every expected part');
  }
  for (let index = 0; index < record.parts.length; index += 1) {
    const expectedNumber = index + 1;
    const expectedSize = Math.min(record.partSize, record.size - index * record.partSize);
    const part = record.parts[index];
    if (part.partNumber !== expectedNumber || part.size !== expectedSize) {
      throw new HttpError(409, 'UPLOAD_INCOMPLETE', 'Upload session does not contain every expected part');
    }
  }
}

function validCompletedItem(item: StorageItem, expectedSize: number): boolean {
  return item.kind === 'file' && (item.size === null || item.size === expectedSize);
}

async function completedEntry(env: Env, record: UploadSessionRecord): Promise<{ entry: MountEntry }> {
  if (!record.completedItem) {
    throw new HttpError(409, 'UPLOAD_INCOMPLETE', 'Upload session has no completed item');
  }
  const { mount, driver } = await sessionDriver(env, record);
  return { entry: externalEntry(record.completedItem, mount, driver, true) };
}

export async function completeResumableUpload(
  env: Env,
  ownerSessionId: string,
  id: string,
): Promise<{ entry: MountEntry }> {
  let record = await ownedSession(env, ownerSessionId, id);
  if (record.status === 'completed') return completedEntry(env, record);
  if (record.status === 'aborted') throw uploadNotFound();
  requireCurrent(record);
  requireCompleteParts(record);

  const now = Date.now();
  const completionOwner = crypto.randomUUID();
  const completionExpiresAt = now + COMPLETION_CLAIM_DURATION_MS;
  let claimed: UploadSessionRecord | null;
  try {
    claimed = await claimCompletion(
      env,
      ownerSessionId,
      id,
      completionOwner,
      completionExpiresAt,
      now,
    );
  } catch {
    throw uploadStatePersistFailed();
  }
  if (!claimed) {
    record = await ownedSession(env, ownerSessionId, id);
    if (record.status === 'completed') return completedEntry(env, record);
    requireCurrent(record, now);
    throw uploadBusy();
  }
  record = claimed;

  const releaseClaim = async (): Promise<void> => {
    try {
      await releaseCompletionClaim(
        env,
        ownerSessionId,
        id,
        completionOwner,
        completionExpiresAt,
      );
    } catch {
      // The lease expiry permits takeover if the exact-token release cannot be persisted.
    }
  };

  let mount: Mount;
  let driver: StorageDriver & { resumableUpload: NonNullable<StorageDriver['resumableUpload']> };
  try {
    ({ mount, driver } = await sessionDriver(env, record));
  } catch (error) {
    await releaseClaim();
    throw error;
  }
  let item: StorageItem;
  try {
    item = await driver.resumableUpload.complete({
      state: record.providerState,
      parts: record.parts,
      ...(record.completedItem ? { completedItem: record.completedItem } : {}),
    });
  } catch (error) {
    await releaseClaim();
    throw normalizeProviderError(error);
  }
  if (!validCompletedItem(item, record.size)) {
    await releaseClaim();
    throw new HttpError(502, 'UPLOAD_PROVIDER_INVALID', 'Storage provider returned an invalid completed item');
  }

  let completed: UploadSessionRecord | null;
  try {
    completed = await completeUploadSessionRecord(
      env,
      ownerSessionId,
      id,
      completionOwner,
      completionExpiresAt,
      item,
    );
  } catch {
    await releaseClaim();
    throw uploadStatePersistFailed();
  }
  if (completed) return { entry: externalEntry(item, mount, driver, true) };
  const current = await ownedSession(env, ownerSessionId, id);
  if (current.status === 'completed') return completedEntry(env, current);
  throw uploadBusy();
}

export async function abortResumableUpload(
  env: Env,
  ownerSessionId: string,
  id: string,
): Promise<void> {
  const record = await ownedSession(env, ownerSessionId, id);
  if (record.status === 'aborted' || record.status === 'completed') return;
  const { driver } = await sessionDriver(env, record);
  try {
    await driver.resumableUpload.abort(record.providerState);
  } catch (error) {
    throw normalizeProviderError(error);
  }
  let aborted: UploadSessionRecord | null;
  try {
    aborted = await markUploadSessionAborted(env, ownerSessionId, id);
  } catch {
    throw uploadStatePersistFailed();
  }
  if (aborted) return;
  const current = await ownedSession(env, ownerSessionId, id);
  if (current.status !== 'aborted' && current.status !== 'completed') throw uploadBusy();
}

export async function cleanupExpiredUploads(env: Env, limit = DEFAULT_CLEANUP_LIMIT): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_CLEANUP_LIMIT) {
    throw new Error('Upload cleanup limit is invalid');
  }
  const expired = await listExpiredUploadSessions(env, Date.now(), limit);
  for (const record of expired) {
    try {
      const { driver } = await sessionDriver(env, record);
      await driver.resumableUpload.abort(record.providerState);
      await markUploadSessionAborted(env, record.ownerSessionId, record.id);
    } catch {
      // Keep failed records eligible for a later cleanup pass.
    }
  }
}
