export async function insertSession(db: D1Database, id: string, expiresAt: number, createdAt: number): Promise<void> {
  await db.prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)')
    .bind(id, expiresAt, createdAt)
    .run();
}

export async function findActiveSession(db: D1Database, id: string, now: number): Promise<{ id: string } | null> {
  return db.prepare('SELECT id FROM sessions WHERE id = ? AND expires_at > ?')
    .bind(id, now)
    .first<{ id: string }>();
}

export async function deleteSessionById(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export async function deleteExpiredSessions(db: D1Database, now: number, limit = 200): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db.prepare(
    `DELETE FROM sessions
     WHERE id IN (
       SELECT id FROM sessions
       WHERE expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT ?
     )`,
  )
    .bind(now, boundedLimit)
    .run();
  return result.meta.changes ?? 0;
}

export async function listExpiredSessionIds(db: D1Database, now: number, limit = 200): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await db.prepare(
    `SELECT id FROM sessions
     WHERE expires_at <= ?
     ORDER BY expires_at ASC
     LIMIT ?`,
  )
    .bind(now, boundedLimit)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}
