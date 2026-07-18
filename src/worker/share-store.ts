import type { EntryKind, Share, ShareRow } from './types';

export interface CreateShareRecordInput {
  tokenHash: string;
  mountId: string;
  providerItemId: string;
  targetKind: EntryKind;
  name: string;
  passwordHash: string | null;
  expiresAt: number | null;
  allowDownload: boolean;
  enabled: boolean;
  maxDownloads?: number | null;
}

export interface UpdateShareRecordInput {
  passwordHash?: string | null;
  expiresAt?: number | null;
  allowDownload?: boolean;
  enabled?: boolean;
  maxDownloads?: number | null;
  tokenHash?: string;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    mountId: row.mount_id,
    providerItemId: row.provider_item_id,
    targetKind: row.target_kind,
    name: row.name,
    passwordHash: row.password_hash,
    authRevision: row.auth_revision,
    expiresAt: row.expires_at,
    allowDownload: row.allow_download === 1,
    enabled: row.enabled === 1,
    downloadCount: row.download_count ?? 0,
    maxDownloads: row.max_downloads ?? null,
    accessCount: row.access_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createShareRecord(db: D1Database, input: CreateShareRecordInput): Promise<Share> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO shares (
    id, token_hash, mount_id, provider_item_id, target_kind, name,
    password_hash, expires_at, allow_download, enabled, download_count, max_downloads, access_count, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`).bind(
    id,
    input.tokenHash,
    input.mountId,
    input.providerItemId,
    input.targetKind,
    input.name,
    input.passwordHash,
    input.expiresAt,
    input.allowDownload ? 1 : 0,
    input.enabled ? 1 : 0,
    input.maxDownloads ?? null,
    now,
    now,
  ).run();
  const share = await getShareById(db, id);
  if (!share) throw new Error('Share write failed');
  return share;
}

export async function getShareById(db: D1Database, id: string): Promise<Share | null> {
  const row = await db.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>();
  return row ? toShare(row) : null;
}

export async function getShareByTokenHash(db: D1Database, tokenHash: string): Promise<Share | null> {
  const row = await db.prepare('SELECT * FROM shares WHERE token_hash = ?').bind(tokenHash).first<ShareRow>();
  return row ? toShare(row) : null;
}

export async function listShares(db: D1Database): Promise<Share[]> {
  const result = await db.prepare('SELECT * FROM shares ORDER BY created_at DESC, id DESC').all<ShareRow>();
  return (result.results ?? []).map(toShare);
}

export async function updateShareRecord(
  db: D1Database,
  id: string,
  input: UpdateShareRecordInput,
): Promise<Share | null> {
  const current = await getShareById(db, id);
  if (!current) return null;
  const passwordChanging = input.passwordHash !== undefined;
  await db.prepare(`UPDATE shares
    SET password_hash = ?,
        auth_revision = auth_revision + ?,
        expires_at = ?,
        allow_download = ?,
        enabled = ?,
        max_downloads = ?,
        token_hash = ?,
        updated_at = ?
    WHERE id = ?`).bind(
    passwordChanging ? input.passwordHash : current.passwordHash,
    passwordChanging ? 1 : 0,
    input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    input.allowDownload === undefined ? (current.allowDownload ? 1 : 0) : (input.allowDownload ? 1 : 0),
    input.enabled === undefined ? (current.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
    input.maxDownloads === undefined ? current.maxDownloads : input.maxDownloads,
    input.tokenHash === undefined ? current.tokenHash : input.tokenHash,
    new Date().toISOString(),
    id,
  ).run();
  return getShareById(db, id);
}

export async function incrementShareAccessCount(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE shares SET access_count = access_count + 1, updated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run();
}

/**
 * Atomically reserve one download against the optional max_downloads limit.
 * Returns false when downloads are disabled or the limit is already reached.
 */
export async function tryConsumeShareDownload(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE shares
    SET download_count = download_count + 1,
        updated_at = ?
    WHERE id = ?
      AND allow_download = 1
      AND (max_downloads IS NULL OR download_count < max_downloads)`).bind(
    new Date().toISOString(),
    id,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function upgradeSharePasswordHash(
  db: D1Database,
  id: string,
  currentHash: string,
  upgradedHash: string,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE shares
    SET password_hash = ?, updated_at = ?
    WHERE id = ? AND password_hash = ?`).bind(
    upgradedHash,
    new Date().toISOString(),
    id,
    currentHash,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function deleteShareRecord(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
