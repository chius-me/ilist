/** Debounce for server-side directory name filter (`GET /api/fs/list?q=`). */
export const DIRECTORY_QUERY_DEBOUNCE_MS = 200;

/** Normalize free-text search before it hits the Worker. */
export function normalizeDirectoryQuery(query: string): string {
  return query.trim();
}

/**
 * Pure decision helper for the explorer search debounce.
 * Returns whether the server query should update and the next value.
 */
export function shouldCommitDirectoryQuery(draft: string, committed: string): {
  commit: boolean;
  next: string;
} {
  const next = normalizeDirectoryQuery(draft);
  return { commit: next !== committed, next };
}
