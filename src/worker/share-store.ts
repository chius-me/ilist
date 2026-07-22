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
}

export interface UpdateShareRecordInput {
  passwordHash?: string | null;
  expiresAt?: number | null;
  allowDownload?: boolean;
  enabled?: boolean;
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
    expiresAt: row.expires_at,
    allowDownload: row.allow_download === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createShareRecord(db: D1Database, input: CreateShareRecordInput): Promise<Share> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO shares (
    id, token_hash, mount_id, provider_item_id, target_kind, name,
    password_hash, expires_at, allow_download, enabled, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
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
  await db.prepare(`UPDATE shares
    SET password_hash = ?, expires_at = ?, allow_download = ?, enabled = ?, updated_at = ?
    WHERE id = ?`).bind(
    input.passwordHash === undefined ? current.passwordHash : input.passwordHash,
    input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    input.allowDownload === undefined ? (current.allowDownload ? 1 : 0) : (input.allowDownload ? 1 : 0),
    input.enabled === undefined ? (current.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
    new Date().toISOString(),
    id,
  ).run();
  return getShareById(db, id);
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
