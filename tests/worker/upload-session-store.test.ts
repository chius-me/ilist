import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  currentAdminSession,
  currentUser,
  requireAdmin,
  requireAdminSession,
} from '../../src/worker/auth';
import { decryptCredential, encryptCredential } from '../../src/worker/crypto';
import type { CompletedUploadPart, StorageItem } from '../../src/worker/drivers/types';
import uploadSessionsMigration from '../../migrations/0012_upload_sessions.sql?raw';
import terminalLeasesMigration from '../../migrations/0013_upload_terminal_leases.sql?raw';
import {
  claimTerminalOperation,
  claimUploadPart,
  completeUploadSessionRecord,
  createUploadSessionRecord,
  getOwnedUploadSession,
  listExpiredUploadSessions,
  markUploadSessionAborted,
  recordUploadPart,
  releaseTerminalOperationClaim,
  releaseUploadPartClaim,
  type CreateUploadSessionRecordInput,
} from '../../src/worker/upload-session-store';
import type { Env, UploadSessionRow } from '../../src/worker/types';

const origin = 'https://ilist.example';
const ownerA = 'owner-session-a';
const ownerB = 'owner-session-b';
const mountId = 'upload-mount';

const workerEnv = () => env as unknown as Env;
const db = () => workerEnv().DB;

const providerState = {
  key: 'tenant/root/archive.bin',
  uploadId: 'private-upload-id',
  parentId: 'root',
  contentType: 'application/octet-stream',
};

const completedItem: StorageItem = {
  id: 'provider-item',
  parentId: 'root',
  name: 'archive.bin',
  kind: 'file',
  size: 15,
  contentType: 'application/octet-stream',
  modifiedAt: '2026-07-17T00:00:00.000Z',
  etag: 'completed-etag',
};

const createInput = (overrides: Partial<CreateUploadSessionRecordInput> = {}): CreateUploadSessionRecordInput => ({
  mountId,
  parentItemId: 'root',
  name: 'archive.bin',
  size: 15,
  contentType: 'application/octet-stream',
  partSize: 10,
  providerState,
  expiresAt: 2_000_000_000_000,
  ...overrides,
});

async function insertSession(id: string): Promise<void> {
  await db()
    .prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)')
    .bind(id, 2_000_000_000, 1_700_000_000)
    .run();
}

async function insertMount(): Promise<void> {
  const now = '2026-07-17T00:00:00.000Z';
  await db()
    .prepare(
      `INSERT INTO mounts (id, name, mount_path, driver_type, provider, created_at, updated_at)
       VALUES (?, 'Uploads', '/uploads', 's3', 'custom', ?, ?)`,
    )
    .bind(mountId, now, now)
    .run();
}

async function createRecord(ownerSessionId = ownerA, overrides: Partial<CreateUploadSessionRecordInput> = {}) {
  return createUploadSessionRecord(workerEnv(), ownerSessionId, createInput(overrides));
}

describe('upload session store', () => {
  beforeEach(async () => {
    await db().prepare('DELETE FROM upload_sessions').run();
    await db().prepare('DELETE FROM sessions').run();
    await db().prepare('DELETE FROM mounts WHERE id = ?').bind(mountId).run();
    await insertSession(ownerA);
    await insertSession(ownerB);
    await insertMount();
  });

  it('keeps terminal leases additive to the already-applied upload session migration', async () => {
    expect(uploadSessionsMigration).not.toMatch(/terminal_operation|terminal_owner|terminal_expires_at|cleanup_attempted_at/);
    expect(terminalLeasesMigration).toMatch(/ALTER TABLE upload_sessions\s+ADD COLUMN terminal_operation/);
    expect(terminalLeasesMigration).toMatch(/ALTER TABLE upload_sessions\s+ADD COLUMN cleanup_attempted_at/);

    const columns = await db().prepare('PRAGMA table_info(upload_sessions)').all<{ name: string }>();
    expect(columns.results?.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'terminal_operation', 'terminal_owner', 'terminal_expires_at', 'cleanup_attempted_at',
    ]));
  });

  it('exposes the authenticated D1 session identity only through internal auth helpers', async () => {
    const created = await createSession(workerEnv());
    const request = new Request(`${origin}/api/admin/me`, {
      headers: { cookie: `ilist_session=${created.token}` },
    });

    const session = await currentAdminSession(workerEnv(), request);
    expect(session).toEqual({ id: expect.any(String), user: { username: 'admin' } });
    expect(session?.id).not.toBe(created.token);
    await expect(requireAdminSession(workerEnv(), request)).resolves.toEqual(session);
    await expect(currentUser(workerEnv(), request)).resolves.toEqual({ username: 'admin' });
    await expect(requireAdmin(workerEnv(), request)).resolves.toEqual({ username: 'admin' });

    const response = await SELF.fetch(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { username: 'admin' } });
  });

  it('isolates records by owner and encrypts provider state with session-specific additional data', async () => {
    const record = await createRecord();
    const raw = await db()
      .prepare('SELECT * FROM upload_sessions WHERE id = ?')
      .bind(record.id)
      .first<UploadSessionRow>();

    expect(record).toMatchObject({
      ownerSessionId: ownerA,
      mountId,
      providerState,
      parts: [],
      completedItem: null,
      status: 'active',
      activePartNumber: null,
      activePartExpiresAt: null,
      terminalOperation: null,
      terminalOwner: null,
      terminalExpiresAt: null,
      cleanupAttemptedAt: 0,
    });
    expect(raw?.provider_state_ciphertext).not.toContain(providerState.uploadId);
    await expect(
      decryptCredential(raw!.provider_state_ciphertext, workerEnv().CREDENTIAL_MASTER_KEY, `upload-session:${record.id}`),
    ).resolves.toEqual(providerState);
    await expect(
      decryptCredential(raw!.provider_state_ciphertext, workerEnv().CREDENTIAL_MASTER_KEY, 'upload-session:other'),
    ).rejects.toThrow('Credential decryption failed');
    await expect(getOwnedUploadSession(workerEnv(), ownerA, record.id)).resolves.toEqual(record);
    await expect(getOwnedUploadSession(workerEnv(), ownerB, record.id)).resolves.toBeNull();
  });

  it.each([
    ['malformed JSON', '{'],
    ['a non-array value', '{}'],
    ['an invalid part', '[{"partNumber":0,"size":1,"etag":null}]'],
    ['duplicate part numbers', '[{"partNumber":1,"size":1,"etag":null},{"partNumber":1,"size":1,"etag":null}]'],
  ])('rejects stored completed parts containing %s', async (_label, partsJson) => {
    const record = await createRecord();
    await db().prepare('UPDATE upload_sessions SET parts_json = ? WHERE id = ?').bind(partsJson, record.id).run();

    await expect(getOwnedUploadSession(workerEnv(), ownerA, record.id)).rejects.toThrow(
      'Stored upload session parts are invalid',
    );
  });

  it('rejects tampered ciphertext and decrypted provider state that is not an object', async () => {
    const tampered = await createRecord();
    await db()
      .prepare('UPDATE upload_sessions SET provider_state_ciphertext = ? WHERE id = ?')
      .bind('{}', tampered.id)
      .run();
    await expect(getOwnedUploadSession(workerEnv(), ownerA, tampered.id)).rejects.toThrow('Credential decryption failed');

    const invalidState = await createRecord();
    const ciphertext = await encryptCredential(
      ['not-an-object'],
      workerEnv().CREDENTIAL_MASTER_KEY,
      `upload-session:${invalidState.id}`,
    );
    await db()
      .prepare('UPDATE upload_sessions SET provider_state_ciphertext = ? WHERE id = ?')
      .bind(ciphertext, invalidState.id)
      .run();
    await expect(getOwnedUploadSession(workerEnv(), ownerA, invalidState.id)).rejects.toThrow(
      'Stored upload session provider state is invalid',
    );
  });

  it.each([
    ['malformed JSON', '{'],
    ['an invalid item', '{"id":42}'],
  ])('rejects a stored completed item containing %s', async (_label, completedItemJson) => {
    const record = await createRecord();
    await db()
      .prepare('UPDATE upload_sessions SET completed_item_json = ? WHERE id = ?')
      .bind(completedItemJson, record.id)
      .run();

    await expect(getOwnedUploadSession(workerEnv(), ownerA, record.id)).rejects.toThrow(
      'Stored upload session completed item is invalid',
    );
  });

  it('allows one active part claim, supports expired takeover, and rejects stale claim transitions', async () => {
    const record = await createRecord();
    const first = await claimUploadPart(workerEnv(), ownerA, record.id, 1, 1_000, 100);

    expect(first).toMatchObject({ activePartNumber: 1, activePartExpiresAt: 1_000 });
    await expect(claimUploadPart(workerEnv(), ownerA, record.id, 2, 2_000, 999)).resolves.toBeNull();
    await expect(claimUploadPart(workerEnv(), ownerB, record.id, 2, 2_000, 1_000)).resolves.toBeNull();

    const takeover = await claimUploadPart(workerEnv(), ownerA, record.id, 1, 2_000, 1_000);
    expect(takeover).toMatchObject({ activePartNumber: 1, activePartExpiresAt: 2_000 });
    await expect(releaseUploadPartClaim(workerEnv(), ownerA, record.id, 1, 1_000)).resolves.toBe(false);
    await expect(
      recordUploadPart(workerEnv(), ownerA, record.id, {
        claimExpiresAt: 1_000,
        part: { partNumber: 1, size: 10, etag: 'etag-1' },
        providerState: { ...providerState, checkpoint: 1 },
      }),
    ).resolves.toBeNull();
    await expect(releaseUploadPartClaim(workerEnv(), ownerA, record.id, 1, 2_000)).resolves.toBe(true);
    await expect(getOwnedUploadSession(workerEnv(), ownerA, record.id)).resolves.toMatchObject({
      activePartNumber: null,
      activePartExpiresAt: null,
    });
  });

  it('arbitrates part and terminal claims without allowing stale part persistence', async () => {
    const record = await createRecord();
    await claimUploadPart(workerEnv(), ownerA, record.id, 1, 1_000, 100);

    await expect(
      claimTerminalOperation(workerEnv(), ownerA, record.id, 'abort', 'abort-a', 2_000, 999),
    ).resolves.toBeNull();
    await expect(
      claimTerminalOperation(workerEnv(), ownerA, record.id, 'complete', 'complete-a', 2_000, 999),
    ).resolves.toBeNull();

    const abortClaim = await claimTerminalOperation(
      workerEnv(), ownerA, record.id, 'abort', 'abort-a', 2_000, 1_000,
    );
    expect(abortClaim).toMatchObject({
      status: 'active',
      activePartNumber: null,
      activePartExpiresAt: null,
      terminalOperation: 'abort',
      terminalOwner: 'abort-a',
      terminalExpiresAt: 2_000,
    });
    await expect(claimUploadPart(workerEnv(), ownerA, record.id, 1, 3_000, 1_001)).resolves.toBeNull();
    await expect(
      recordUploadPart(workerEnv(), ownerA, record.id, {
        claimExpiresAt: 1_000,
        part: { partNumber: 1, size: 10, etag: 'stale' },
        providerState,
      }),
    ).resolves.toBeNull();
  });

  it('fails closed instead of claiming over a malformed half-claim state', async () => {
    const record = await createRecord();
    await db()
      .prepare('UPDATE upload_sessions SET active_part_number = NULL, active_part_expires_at = ? WHERE id = ?')
      .bind(2_000, record.id)
      .run();

    await expect(claimUploadPart(workerEnv(), ownerA, record.id, 1, 3_000, 100)).resolves.toBeNull();
  });

  it('records ordered parts, encrypted state, optional completion, and matching duplicate retries', async () => {
    const record = await createRecord();
    const secondPart: CompletedUploadPart = { partNumber: 2, size: 5, etag: 'etag-2' };
    const firstPart: CompletedUploadPart = { partNumber: 1, size: 10, etag: 'etag-1' };

    await claimUploadPart(workerEnv(), ownerA, record.id, 2, 2_000, 100);
    const afterSecond = await recordUploadPart(workerEnv(), ownerA, record.id, {
      claimExpiresAt: 2_000,
      part: secondPart,
      providerState: { ...providerState, checkpoint: 2 },
    });
    expect(afterSecond?.parts).toEqual([secondPart]);

    await claimUploadPart(workerEnv(), ownerA, record.id, 1, 3_000, 200);
    const afterFirst = await recordUploadPart(workerEnv(), ownerA, record.id, {
      claimExpiresAt: 3_000,
      part: firstPart,
      providerState: { ...providerState, checkpoint: 3 },
      completedItem,
    });
    expect(afterFirst).toMatchObject({
      parts: [firstPart, secondPart],
      providerState: { ...providerState, checkpoint: 3 },
      completedItem,
      activePartNumber: null,
      activePartExpiresAt: null,
    });

    await expect(
      recordUploadPart(workerEnv(), ownerA, record.id, {
        claimExpiresAt: 3_000,
        part: firstPart,
        providerState: { ...providerState, checkpoint: 999 },
      }),
    ).resolves.toMatchObject({ parts: [firstPart, secondPart], providerState: { checkpoint: 3 } });
    await expect(
      recordUploadPart(workerEnv(), ownerA, record.id, {
        claimExpiresAt: 3_000,
        part: { ...firstPart, etag: 'different' },
        providerState,
      }),
    ).rejects.toThrow('Recorded upload part does not match');
    await expect(
      recordUploadPart(workerEnv(), ownerA, record.id, {
        claimExpiresAt: 3_000,
        part: { ...firstPart, size: 9 },
        providerState,
      }),
    ).rejects.toThrow('Recorded upload part does not match');

    const raw = await db()
      .prepare('SELECT provider_state_ciphertext, parts_json FROM upload_sessions WHERE id = ?')
      .bind(record.id)
      .first<Pick<UploadSessionRow, 'provider_state_ciphertext' | 'parts_json'>>();
    expect(raw?.provider_state_ciphertext).not.toContain(providerState.uploadId);
    expect(JSON.parse(raw!.parts_json)).toEqual([firstPart, secondPart]);
    await expect(
      decryptCredential(raw!.provider_state_ciphertext, workerEnv().CREDENTIAL_MASTER_KEY, `upload-session:${record.id}`),
    ).resolves.toEqual({ ...providerState, checkpoint: 3 });
  });

  it('arbitrates completion and abort leases and rejects stale operation transitions after takeover', async () => {
    const record = await createRecord();
    const claimed = await claimTerminalOperation(
      workerEnv(), ownerA, record.id, 'complete', 'completion-a', 1_000, 100,
    );

    expect(claimed).toMatchObject({
      status: 'completing',
      terminalOperation: 'complete',
      terminalOwner: 'completion-a',
      terminalExpiresAt: 1_000,
    });
    await expect(
      claimTerminalOperation(workerEnv(), ownerA, record.id, 'abort', 'abort-b', 2_000, 999),
    ).resolves.toBeNull();
    await expect(claimUploadPart(workerEnv(), ownerA, record.id, 1, 2_000, 100)).resolves.toBeNull();

    const takeover = await claimTerminalOperation(
      workerEnv(), ownerA, record.id, 'abort', 'abort-b', 2_000, 1_000,
    );
    expect(takeover).toMatchObject({
      status: 'active',
      terminalOperation: 'abort',
      terminalOwner: 'abort-b',
      terminalExpiresAt: 2_000,
    });
    await expect(
      completeUploadSessionRecord(workerEnv(), ownerA, record.id, 'completion-a', 1_000, completedItem),
    ).resolves.toBeNull();
    await expect(
      releaseTerminalOperationClaim(workerEnv(), ownerA, record.id, 'complete', 'completion-a', 1_000),
    ).resolves.toBe(false);
    await expect(
      markUploadSessionAborted(workerEnv(), ownerA, record.id, 'abort-a', 1_000),
    ).resolves.toBeNull();

    const aborted = await markUploadSessionAborted(workerEnv(), ownerA, record.id, 'abort-b', 2_000);
    expect(aborted).toMatchObject({
      status: 'aborted', terminalOperation: null, terminalOwner: null, terminalExpiresAt: null,
    });
    await expect(
      markUploadSessionAborted(workerEnv(), ownerA, record.id, 'abort-b', 2_000),
    ).resolves.toBeNull();
  });

  it('persists and releases only an exact terminal operation lease', async () => {
    const record = await createRecord();
    await claimTerminalOperation(workerEnv(), ownerA, record.id, 'complete', 'completion-a', 1_000, 100);

    await expect(
      releaseTerminalOperationClaim(workerEnv(), ownerA, record.id, 'abort', 'completion-a', 1_000),
    ).resolves.toBe(false);
    await expect(
      releaseTerminalOperationClaim(workerEnv(), ownerA, record.id, 'complete', 'completion-a', 1_000),
    ).resolves.toBe(true);
    await expect(getOwnedUploadSession(workerEnv(), ownerA, record.id)).resolves.toMatchObject({
      status: 'active',
      terminalOperation: null,
      terminalOwner: null,
      terminalExpiresAt: null,
    });

    await claimTerminalOperation(workerEnv(), ownerA, record.id, 'complete', 'completion-b', 2_000, 200);
    const completed = await completeUploadSessionRecord(
      workerEnv(), ownerA, record.id, 'completion-b', 2_000, completedItem,
    );
    expect(completed).toMatchObject({
      status: 'completed', completedItem, terminalOperation: null, terminalOwner: null, terminalExpiresAt: null,
    });
  });

  it('fails closed instead of claiming over a malformed half-terminal lease', async () => {
    const record = await createRecord();
    await db()
      .prepare(
        "UPDATE upload_sessions SET terminal_operation = 'complete', terminal_owner = NULL, terminal_expires_at = ? WHERE id = ?",
      )
      .bind(1_000, record.id)
      .run();

    await expect(
      claimTerminalOperation(workerEnv(), ownerA, record.id, 'complete', 'completion-b', 2_000, 1_000),
    ).resolves.toBeNull();
  });

  it('lists only expired sessions without live claims and respects cleanup-attempt ordering and the limit', async () => {
    const later = await createRecord(ownerA, { expiresAt: 200 });
    const first = await createRecord(ownerA, { expiresAt: 100 });
    const livePart = await createRecord(ownerA, { expiresAt: 120 });
    const liveTerminal = await createRecord(ownerB, { expiresAt: 130 });
    const expiredTerminal = await createRecord(ownerB, { expiresAt: 150 });
    const aborted = await createRecord(ownerB, { expiresAt: 50 });
    await claimUploadPart(workerEnv(), ownerA, livePart.id, 1, 1_000, 100);
    await claimTerminalOperation(workerEnv(), ownerB, liveTerminal.id, 'abort', 'live-abort', 1_000, 100);
    await claimTerminalOperation(workerEnv(), ownerB, expiredTerminal.id, 'complete', 'expired-complete', 200, 100);
    await claimTerminalOperation(workerEnv(), ownerB, aborted.id, 'abort', 'aborted', 1_000, 100);
    await markUploadSessionAborted(workerEnv(), ownerB, aborted.id, 'aborted', 1_000);
    await createRecord(ownerA, { expiresAt: 400 });

    const expired = await listExpiredUploadSessions(workerEnv(), 250, 2);

    expect(expired.map((session) => session.id)).toEqual([first.id, expiredTerminal.id]);
    expect(expired.map((session) => session.status)).toEqual(['active', 'completing']);
    expect(expired).not.toContainEqual(expect.objectContaining({ id: later.id }));
    expect(expired).not.toContainEqual(expect.objectContaining({ id: livePart.id }));
    expect(expired).not.toContainEqual(expect.objectContaining({ id: liveTerminal.id }));
  });

  it('rotates malformed expired rows instead of failing or starving the next cleanup candidate', async () => {
    const malformed = await createRecord(ownerA, { expiresAt: 100 });
    const valid = await createRecord(ownerB, { expiresAt: 101 });
    await db().prepare('UPDATE upload_sessions SET provider_state_ciphertext = ? WHERE id = ?')
      .bind('{malformed', malformed.id)
      .run();

    await expect(listExpiredUploadSessions(workerEnv(), 500, 1)).resolves.toEqual([]);
    await expect(db().prepare('SELECT cleanup_attempted_at FROM upload_sessions WHERE id = ?')
      .bind(malformed.id).first()).resolves.toEqual({ cleanup_attempted_at: 500 });

    const next = await listExpiredUploadSessions(workerEnv(), 501, 1);
    expect(next.map(({ id }) => id)).toEqual([valid.id]);
  });

  it('cascades cleanup when the owning administrator session or mount is deleted', async () => {
    const owned = await createRecord(ownerA);
    await db().prepare('DELETE FROM sessions WHERE id = ?').bind(ownerA).run();
    await expect(
      db().prepare('SELECT id FROM upload_sessions WHERE id = ?').bind(owned.id).first(),
    ).resolves.toBeNull();

    const mounted = await createRecord(ownerB);
    await db().prepare('DELETE FROM mounts WHERE id = ?').bind(mountId).run();
    await expect(
      db().prepare('SELECT id FROM upload_sessions WHERE id = ?').bind(mounted.id).first(),
    ).resolves.toBeNull();
  });
});
