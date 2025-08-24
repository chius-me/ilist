export const LOCAL_MIGRATION_LEASE_DURATION_MS: number;
export const REMOTE_MIGRATION_LEASE_DURATION_MS: number;

export function migrationLeaseDuration(mode: '--local' | '--remote'): number;
export function migrationLeaseValue(owner: string, now: number, mode: '--local' | '--remote'): string;
