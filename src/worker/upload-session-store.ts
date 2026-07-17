import { decryptCredential, encryptCredential } from './crypto';
import type { CompletedUploadPart, StorageItem } from './drivers/types';
import type { Env, UploadSessionRow, UploadSessionStatus } from './types';

export interface UploadSessionRecord {
  id: string;
  ownerSessionId: string;
  mountId: string;
  parentItemId: string;
  name: string;
  size: number;
  contentType: string | null;
  partSize: number;
  providerState: Record<string, unknown>;
  parts: CompletedUploadPart[];
  completedItem: StorageItem | null;
  status: UploadSessionStatus;
  activePartNumber: number | null;
  activePartExpiresAt: number | null;
  completionOwner: string | null;
  completionExpiresAt: number | null;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUploadSessionRecordInput {
  mountId: string;
  parentItemId: string;
  name: string;
  size: number;
  contentType: string | null;
  partSize: number;
  providerState: Record<string, unknown>;
  expiresAt: number;
}

export interface RecordUploadPartInput {
  claimExpiresAt: number;
  part: CompletedUploadPart;
  providerState: Record<string, unknown>;
  completedItem?: StorageItem;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCompletedUploadPart(value: unknown): value is CompletedUploadPart {
  if (!isObject(value)) return false;
  return isSafeInteger(value.partNumber, 1) && isSafeInteger(value.size, 0) && isNullableString(value.etag);
}

function assertCompletedUploadPart(value: unknown): asserts value is CompletedUploadPart {
  if (!isCompletedUploadPart(value)) throw new Error('Upload part is invalid');
}

function isStorageItem(value: unknown): value is StorageItem {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    isNullableString(value.parentId) &&
    typeof value.name === 'string' &&
    value.kind === 'file' &&
    (value.size === null || isSafeInteger(value.size, 0)) &&
    isNullableString(value.contentType) &&
    isNullableString(value.modifiedAt) &&
    isNullableString(value.etag)
  );
}

function assertStorageItem(value: unknown): asserts value is StorageItem {
  if (!isStorageItem(value)) throw new Error('Completed upload item is invalid');
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(message);
  }
}

function parseParts(value: string): CompletedUploadPart[] {
  const parsed = parseJson(value, 'Stored upload session parts are invalid');
  if (!Array.isArray(parsed)) throw new Error('Stored upload session parts are invalid');

  const seen = new Set<number>();
  const parts: CompletedUploadPart[] = [];
  for (const part of parsed) {
    if (!isCompletedUploadPart(part) || seen.has(part.partNumber)) {
      throw new Error('Stored upload session parts are invalid');
    }
    seen.add(part.partNumber);
    parts.push(part);
  }
  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

function parseCompletedItem(value: string | null): StorageItem | null {
  if (value === null) return null;
  const parsed = parseJson(value, 'Stored upload session completed item is invalid');
  if (!isStorageItem(parsed)) throw new Error('Stored upload session completed item is invalid');
  return parsed;
}

function assertStoredRow(row: UploadSessionRow): void {
  const validStatus = row.status === 'active' || row.status === 'completing' || row.status === 'completed' || row.status === 'aborted';
  const validActiveClaim =
    (row.active_part_number === null && row.active_part_expires_at === null) ||
    (isSafeInteger(row.active_part_number, 1) && isSafeInteger(row.active_part_expires_at, 0));
  const validCompletionClaim =
    (row.completion_owner === null && row.completion_expires_at === null) ||
    (typeof row.completion_owner === 'string' &&
      row.completion_owner.length > 0 &&
      isSafeInteger(row.completion_expires_at, 0));
  const completionClaimMatchesStatus =
    row.status === 'completing'
      ? row.completion_owner !== null && row.completion_expires_at !== null
      : row.completion_owner === null && row.completion_expires_at === null;
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.owner_session_id !== 'string' ||
    !row.owner_session_id ||
    typeof row.mount_id !== 'string' ||
    !row.mount_id ||
    typeof row.parent_item_id !== 'string' ||
    typeof row.name !== 'string' ||
    !isSafeInteger(row.size, 0) ||
    !isNullableString(row.content_type) ||
    !isSafeInteger(row.part_size, 1) ||
    typeof row.provider_state_ciphertext !== 'string' ||
    typeof row.parts_json !== 'string' ||
    !isNullableString(row.completed_item_json) ||
    !validStatus ||
    !validActiveClaim ||
    !validCompletionClaim ||
    !completionClaimMatchesStatus ||
    !isSafeInteger(row.expires_at, 0) ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string'
  ) {
    throw new Error('Stored upload session row is invalid');
  }
}

function assertProviderState(value: unknown, stored = false): asserts value is Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(stored ? 'Stored upload session provider state is invalid' : 'Upload session provider state is invalid');
  }
}

function assertCreateInput(ownerSessionId: string, input: CreateUploadSessionRecordInput): void {
  if (
    !ownerSessionId ||
    !input.mountId ||
    typeof input.parentItemId !== 'string' ||
    typeof input.name !== 'string' ||
    !isSafeInteger(input.size, 0) ||
    !isNullableString(input.contentType) ||
    !isSafeInteger(input.partSize, 1) ||
    !isSafeInteger(input.expiresAt, 0)
  ) {
    throw new Error('Upload session input is invalid');
  }
  assertProviderState(input.providerState);
}

async function rowToRecord(env: Env, row: UploadSessionRow): Promise<UploadSessionRecord> {
  assertStoredRow(row);
  const providerState = await decryptCredential(
    row.provider_state_ciphertext,
    env.CREDENTIAL_MASTER_KEY,
    `upload-session:${row.id}`,
  );
  assertProviderState(providerState, true);

  return {
    id: row.id,
    ownerSessionId: row.owner_session_id,
    mountId: row.mount_id,
    parentItemId: row.parent_item_id,
    name: row.name,
    size: row.size,
    contentType: row.content_type,
    partSize: row.part_size,
    providerState,
    parts: parseParts(row.parts_json),
    completedItem: parseCompletedItem(row.completed_item_json),
    status: row.status,
    activePartNumber: row.active_part_number,
    activePartExpiresAt: row.active_part_expires_at,
    completionOwner: row.completion_owner,
    completionExpiresAt: row.completion_expires_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getOwnedUploadSessionRow(
  env: Env,
  ownerSessionId: string,
  id: string,
): Promise<UploadSessionRow | null> {
  return env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ? AND owner_session_id = ?')
    .bind(id, ownerSessionId)
    .first<UploadSessionRow>();
}

function samePart(left: CompletedUploadPart, right: CompletedUploadPart): boolean {
  return left.partNumber === right.partNumber && left.size === right.size && left.etag === right.etag;
}

export async function createUploadSessionRecord(
  env: Env,
  ownerSessionId: string,
  input: CreateUploadSessionRecordInput,
): Promise<UploadSessionRecord> {
  assertCreateInput(ownerSessionId, input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ciphertext = await encryptCredential(
    input.providerState,
    env.CREDENTIAL_MASTER_KEY,
    `upload-session:${id}`,
  );

  await env.DB.prepare(
    `INSERT INTO upload_sessions (
       id, owner_session_id, mount_id, parent_item_id, name, size, content_type, part_size,
       provider_state_ciphertext, parts_json, completed_item_json, status,
       active_part_number, active_part_expires_at, completion_owner, completion_expires_at,
       expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 'active', NULL, NULL, NULL, NULL, ?, ?, ?)`,
  )
    .bind(
      id,
      ownerSessionId,
      input.mountId,
      input.parentItemId,
      input.name,
      input.size,
      input.contentType,
      input.partSize,
      ciphertext,
      input.expiresAt,
      now,
      now,
    )
    .run();

  const record = await getOwnedUploadSession(env, ownerSessionId, id);
  if (!record) throw new Error('Created upload session was not found');
  return record;
}

export async function getOwnedUploadSession(
  env: Env,
  ownerSessionId: string,
  id: string,
): Promise<UploadSessionRecord | null> {
  const row = await getOwnedUploadSessionRow(env, ownerSessionId, id);
  return row ? rowToRecord(env, row) : null;
}

export async function claimUploadPart(
  env: Env,
  ownerSessionId: string,
  id: string,
  partNumber: number,
  claimExpiresAt: number,
  now = Date.now(),
): Promise<UploadSessionRecord | null> {
  if (!isSafeInteger(partNumber, 1) || !isSafeInteger(now, 0) || !isSafeInteger(claimExpiresAt, now + 1)) {
    throw new Error('Upload part claim is invalid');
  }

  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET active_part_number = ?, active_part_expires_at = ?, updated_at = ?
     WHERE id = ?
       AND owner_session_id = ?
       AND status = 'active'
       AND expires_at > ?
       AND completion_owner IS NULL
       AND completion_expires_at IS NULL
       AND (
         (active_part_number IS NULL AND active_part_expires_at IS NULL)
         OR (
           active_part_number IS NOT NULL
           AND active_part_expires_at IS NOT NULL
           AND active_part_expires_at <= ?
         )
       )`,
  )
    .bind(partNumber, claimExpiresAt, new Date(now).toISOString(), id, ownerSessionId, now, now)
    .run();
  if (result.meta.changes !== 1) return null;
  return getOwnedUploadSession(env, ownerSessionId, id);
}

export async function recordUploadPart(
  env: Env,
  ownerSessionId: string,
  id: string,
  input: RecordUploadPartInput,
): Promise<UploadSessionRecord | null> {
  if (!isSafeInteger(input.claimExpiresAt, 0)) throw new Error('Upload part claim is invalid');
  assertCompletedUploadPart(input.part);
  assertProviderState(input.providerState);
  if (input.completedItem !== undefined) assertStorageItem(input.completedItem);

  const row = await getOwnedUploadSessionRow(env, ownerSessionId, id);
  if (!row) return null;
  const record = await rowToRecord(env, row);
  const existing = record.parts.find((part) => part.partNumber === input.part.partNumber);
  if (existing && !samePart(existing, input.part)) throw new Error('Recorded upload part does not match');

  const ownsClaim =
    record.status === 'active' &&
    record.activePartNumber === input.part.partNumber &&
    record.activePartExpiresAt === input.claimExpiresAt;
  if (existing && !ownsClaim) return record;
  if (!existing && !ownsClaim) return null;

  const parts = existing
    ? record.parts
    : [...record.parts, input.part].sort((left, right) => left.partNumber - right.partNumber);
  const ciphertext = await encryptCredential(
    input.providerState,
    env.CREDENTIAL_MASTER_KEY,
    `upload-session:${id}`,
  );
  const completedItemJson = input.completedItem === undefined
    ? row.completed_item_json
    : JSON.stringify(input.completedItem);
  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET provider_state_ciphertext = ?,
         parts_json = ?,
         completed_item_json = ?,
         active_part_number = NULL,
         active_part_expires_at = NULL,
         updated_at = ?
     WHERE id = ?
       AND owner_session_id = ?
       AND status = 'active'
       AND active_part_number = ?
       AND active_part_expires_at = ?
       AND parts_json = ?
       AND provider_state_ciphertext = ?
       AND completed_item_json IS ?`,
  )
    .bind(
      ciphertext,
      JSON.stringify(parts),
      completedItemJson,
      new Date().toISOString(),
      id,
      ownerSessionId,
      input.part.partNumber,
      input.claimExpiresAt,
      row.parts_json,
      row.provider_state_ciphertext,
      row.completed_item_json,
    )
    .run();
  if (result.meta.changes === 1) return getOwnedUploadSession(env, ownerSessionId, id);

  const current = await getOwnedUploadSession(env, ownerSessionId, id);
  const recorded = current?.parts.find((part) => part.partNumber === input.part.partNumber);
  if (recorded && !samePart(recorded, input.part)) throw new Error('Recorded upload part does not match');
  return recorded ? current : null;
}

export async function releaseUploadPartClaim(
  env: Env,
  ownerSessionId: string,
  id: string,
  partNumber: number,
  claimExpiresAt: number,
): Promise<boolean> {
  if (!isSafeInteger(partNumber, 1) || !isSafeInteger(claimExpiresAt, 0)) {
    throw new Error('Upload part claim is invalid');
  }
  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET active_part_number = NULL, active_part_expires_at = NULL, updated_at = ?
     WHERE id = ?
       AND owner_session_id = ?
       AND status = 'active'
       AND active_part_number = ?
       AND active_part_expires_at = ?`,
  )
    .bind(new Date().toISOString(), id, ownerSessionId, partNumber, claimExpiresAt)
    .run();
  return result.meta.changes === 1;
}

export async function claimCompletion(
  env: Env,
  ownerSessionId: string,
  id: string,
  completionOwner: string,
  completionExpiresAt: number,
  now = Date.now(),
): Promise<UploadSessionRecord | null> {
  if (
    !completionOwner ||
    !isSafeInteger(now, 0) ||
    !isSafeInteger(completionExpiresAt, now + 1)
  ) {
    throw new Error('Upload completion claim is invalid');
  }
  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET status = 'completing', completion_owner = ?, completion_expires_at = ?, updated_at = ?
     WHERE id = ?
       AND owner_session_id = ?
       AND expires_at > ?
       AND active_part_number IS NULL
       AND active_part_expires_at IS NULL
       AND (
         (
           status = 'active'
           AND completion_owner IS NULL
           AND completion_expires_at IS NULL
         )
         OR (
           status = 'completing'
           AND completion_owner IS NOT NULL
           AND completion_expires_at IS NOT NULL
           AND completion_expires_at <= ?
         )
       )`,
  )
    .bind(completionOwner, completionExpiresAt, new Date(now).toISOString(), id, ownerSessionId, now, now)
    .run();
  if (result.meta.changes !== 1) return null;
  return getOwnedUploadSession(env, ownerSessionId, id);
}

export async function completeUploadSessionRecord(
  env: Env,
  ownerSessionId: string,
  id: string,
  completionOwner: string,
  completionExpiresAt: number,
  item: StorageItem,
): Promise<UploadSessionRecord | null> {
  if (!completionOwner || !isSafeInteger(completionExpiresAt, 0)) {
    throw new Error('Upload completion claim is invalid');
  }
  assertStorageItem(item);
  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET status = 'completed',
         completed_item_json = ?,
         completion_owner = NULL,
         completion_expires_at = NULL,
         updated_at = ?
     WHERE id = ?
       AND owner_session_id = ?
       AND status = 'completing'
       AND completion_owner = ?
       AND completion_expires_at = ?`,
  )
    .bind(JSON.stringify(item), new Date().toISOString(), id, ownerSessionId, completionOwner, completionExpiresAt)
    .run();
  if (result.meta.changes !== 1) return null;
  return getOwnedUploadSession(env, ownerSessionId, id);
}

export async function releaseCompletionClaim(
  env: Env,
  ownerSessionId: string,
  id: string,
  completionOwner: string,
  completionExpiresAt: number,
): Promise<boolean> {
  if (!completionOwner || !isSafeInteger(completionExpiresAt, 0)) {
    throw new Error('Upload completion claim is invalid');
  }
  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET status = 'active',
         completion_owner = NULL,
         completion_expires_at = NULL,
         updated_at = ?
     WHERE id = ?
       AND owner_session_id = ?
       AND status = 'completing'
       AND completion_owner = ?
       AND completion_expires_at = ?`,
  )
    .bind(new Date().toISOString(), id, ownerSessionId, completionOwner, completionExpiresAt)
    .run();
  return result.meta.changes === 1;
}

export async function markUploadSessionAborted(
  env: Env,
  ownerSessionId: string,
  id: string,
): Promise<UploadSessionRecord | null> {
  const current = await getOwnedUploadSession(env, ownerSessionId, id);
  if (!current || current.status === 'completed') return null;
  if (current.status === 'aborted') return current;

  const result = await env.DB.prepare(
    `UPDATE upload_sessions
     SET status = 'aborted',
         active_part_number = NULL,
         active_part_expires_at = NULL,
         completion_owner = NULL,
         completion_expires_at = NULL,
         updated_at = ?
     WHERE id = ? AND owner_session_id = ? AND status IN ('active', 'completing')`,
  )
    .bind(new Date().toISOString(), id, ownerSessionId)
    .run();
  if (result.meta.changes === 1) return getOwnedUploadSession(env, ownerSessionId, id);

  const updated = await getOwnedUploadSession(env, ownerSessionId, id);
  return updated?.status === 'aborted' ? updated : null;
}

export async function listExpiredUploadSessions(
  env: Env,
  now = Date.now(),
  limit = 10,
): Promise<UploadSessionRecord[]> {
  if (!isSafeInteger(now, 0) || !isSafeInteger(limit, 1)) throw new Error('Upload session expiration query is invalid');
  const result = await env.DB.prepare(
    `SELECT * FROM upload_sessions
     WHERE status IN ('active', 'completing') AND expires_at <= ?
     ORDER BY expires_at ASC, created_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<UploadSessionRow>();

  return Promise.all((result.results ?? []).map((row) => rowToRecord(env, row)));
}
