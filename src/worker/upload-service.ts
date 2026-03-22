import { createDriver } from './drivers/registry';
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
  releaseUploadPartClaim,
  type UploadSessionRecord,
} from './upload-session-store';
import type { Env, Mount, MountEntry, UploadSessionStatus } from './types';

const PART_CLAIM_DURATION_MS = 5 * 60_000;
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

function normalizeProviderError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(502, 'UPLOAD_PROVIDER_FAILED', 'Storage provider upload failed');
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
    throw error;
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
  if (initial.status !== 'active') throw uploadBusy();
  const expected = expectedPart(initial, partNumber);
  requirePartRequest(request, expected.size);
  const duplicate = recordedPart(initial, partNumber, expected.size);
  if (duplicate) return duplicate;

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

  try {
    const result = await driver.resumableUpload.uploadPart({
      state: claimed.providerState,
      partNumber,
      offset: expected.offset,
      totalSize: claimed.size,
      body: request.body!,
      size: expected.size,
      signal: request.signal,
    });
    if (!validProviderPart(result, partNumber, expected.size)) {
      throw new HttpError(502, 'UPLOAD_PROVIDER_INVALID', 'Storage provider returned an invalid upload part');
    }
    const updated = await recordUploadPart(env, ownerSessionId, id, {
      claimExpiresAt,
      part: result.part,
      providerState: result.state ?? claimed.providerState,
      ...(result.completedItem ? { completedItem: result.completedItem } : {}),
    });
    if (!updated) throw uploadBusy();
    const stored = recordedPart(updated, partNumber, expected.size);
    if (!stored) throw uploadBusy();
    return stored;
  } catch (error) {
    try {
      await releaseUploadPartClaim(env, ownerSessionId, id, partNumber, claimExpiresAt);
    } catch {
      // Claim expiry permits a later retry even when best-effort release fails.
    }
    throw normalizeProviderError(error);
  }
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

  if (record.status === 'active') {
    const claimed = await claimCompletion(env, ownerSessionId, id);
    if (!claimed) {
      record = await ownedSession(env, ownerSessionId, id);
      if (record.status === 'completed') return completedEntry(env, record);
      requireCurrent(record);
      if (record.status !== 'completing') throw uploadBusy();
    } else {
      record = claimed;
    }
  }

  const { mount, driver } = await sessionDriver(env, record);
  let item: StorageItem;
  try {
    item = await driver.resumableUpload.complete({
      state: record.providerState,
      parts: record.parts,
      ...(record.completedItem ? { completedItem: record.completedItem } : {}),
    });
  } catch (error) {
    throw normalizeProviderError(error);
  }
  if (!validCompletedItem(item, record.size)) {
    throw new HttpError(502, 'UPLOAD_PROVIDER_INVALID', 'Storage provider returned an invalid completed item');
  }

  const completed = await completeUploadSessionRecord(env, ownerSessionId, id, item);
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
  const aborted = await markUploadSessionAborted(env, ownerSessionId, id);
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
