export const LOCAL_MIGRATION_LEASE_DURATION_MS = 15 * 60_000;
// Remote D1 imports can make the database unavailable to lease renewals.
// Six hours covers the complete expected import while retaining bounded recovery.
export const REMOTE_MIGRATION_LEASE_DURATION_MS = 6 * 60 * 60_000;

export function migrationLeaseDuration(mode) {
  if (mode === '--local') return LOCAL_MIGRATION_LEASE_DURATION_MS;
  if (mode === '--remote') return REMOTE_MIGRATION_LEASE_DURATION_MS;
  throw new Error(`Unsupported migration mode: ${mode}`);
}

export function migrationLeaseValue(owner, now, mode) {
  return JSON.stringify({ owner, expires_at: now + migrationLeaseDuration(mode) });
}
