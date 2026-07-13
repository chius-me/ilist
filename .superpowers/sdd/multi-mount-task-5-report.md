# Task 5: Virtual Root and Native R2 Compatibility Mount Report

## Status

Implemented Task 5 on `feat/ilist-core-file-manager`. The implementation exposes enabled mounts at the virtual root, preserves guest mount and entry visibility, and keeps the existing native R2 entry tree available beneath `/R2` without changing entry IDs, object keys, or file-serving routes.

## TDD Evidence

### RED

Command:

```sh
npm run test:worker -- tests/worker/file-system.test.ts tests/worker/router.test.ts
```

Observed result before implementation: failed with exit code 1. Both focused suites failed to load because `migrations/0010_native_r2_compat_mount.sql` did not exist. This was the expected missing-compatibility-mount failure.

### GREEN

Focused command:

```sh
npm run test:worker -- tests/worker/file-system.test.ts tests/worker/router.test.ts
```

Observed result: passed with exit code 0; 2 test files and 24 tests passed.

Full Worker command:

```sh
npm run test:worker
```

Observed result: passed with exit code 0; 13 test files and 114 tests passed.

Final project verification:

```sh
npm run check
git diff --check
```

Observed result: passed with exit code 0. TypeScript checking and the production build passed; 13 Worker files with 114 tests passed; 7 UI files with 22 tests passed; and the whitespace check reported no errors.

## Changed Files

- `migrations/0010_native_r2_compat_mount.sql`: inserts the deterministic `native-r2` mount at `/R2` only when its stable ID is absent. Reapplying the SQL leaves exactly one compatibility mount.
- `src/worker/file-system.ts`: lists synthetic read-only mount folders at `/`, filters disabled and private mounts for guests, resolves mounted paths, and translates native R2 paths and breadcrumbs back to the existing entry tree.
- `src/worker/router.ts`: routes filesystem list requests through the virtual directory dispatcher. Stable and legacy file handlers are unchanged.
- `src/worker/types.ts`: adds mount-aware entry and virtual directory response types without changing existing entry types or IDs.
- `tests/worker/file-system.test.ts`: covers migration idempotency, deterministic mount metadata, guest/admin visibility, provider-failure isolation, private direct-path hiding, and native R2 entry-tree access.
- `tests/worker/router.test.ts`: covers root and `/R2` listing together with unchanged stable entry streaming and legacy key redirects.
- `.superpowers/sdd/multi-mount-task-5-report.md`: records implementation and verification evidence.

## Compatibility Review

- The migration writes only one row to `mounts`; it does not update `entries`, `objects`, or R2 objects.
- Native mounted listings reuse the existing `listDirectory()` implementation, including inherited guest visibility and existing entry capabilities.
- Native entries retain their current IDs and receive only additive mount identity fields in list responses.
- `/file/:id/:name` still streams through the existing stable entry path and uses the existing `storage_key`.
- Legacy `/file/<key>` still resolves through `objects`, finds the unchanged entry storage key, and redirects to the stable entry URL.
- Root listing calls only `listMounts()`. It does not instantiate a driver, load credentials, or contact a provider, so an unavailable provider cannot prevent the virtual root response.
- Disabled mounts are omitted for both guests and administrators. Private mounts are omitted for guests and return `MOUNT_NOT_FOUND` when addressed directly by a guest.

## Self-Review

- Confirmed the compatibility mount has stable ID `native-r2`, path `/R2`, provider `cloudflare-r2`, native root item `root`, and public/enabled defaults.
- Confirmed migration SQL is idempotent by applying it twice against the production schema and asserting one native R2 row.
- Confirmed mount order remains the repository order: `sort_order`, then case-insensitive name.
- Confirmed virtual and mount folders expose no rename, move, delete, visibility, preview, or download capabilities.
- Confirmed native breadcrumbs prepend virtual root and mount crumbs while retaining encoded entry-relative paths.
- Confirmed no existing file route, R2 upload/download call, storage-key function, entry repository, legacy object route, or shared test setup was modified.
- Confirmed the working diff contains only Task 5 implementation/test files and this report.

## Concerns

- Opening non-native mounts remains intentionally unavailable in Task 5 and returns `DRIVER_UNAVAILABLE`; later S3/OneDrive and integration dispatch tasks own provider browsing and operations. Root listing remains available regardless.
- The current UI navigates folders by `entry.name`, while mount responses also expose the authoritative `mountPath`. The native compatibility mount uses matching values (`R2` and `/R2`), so Task 5 works end to end; later multi-provider UI integration must navigate by `mountPath` when a display name differs from its path.
- Shared Worker setup is outside Task 5 ownership and still applies migrations through `0009`; the Task 5 suites apply production migration `0010` explicitly. A later migration-sequence owner should add `0010` to centralized setup.
- Test runners emit existing non-failing warnings about process-environment secrets and unavailable Node localStorage. Deterministic Worker bindings are supplied by Vitest, and all verification passed.

## Commit

`feat: expose virtual storage mounts` (hash reported in the task handoff).

## Fix Review

### Review Findings Resolved

- Added `mountPath` to the common Worker and UI `Entry` contracts. Ordinary entries serialize it as `null`; mount and mounted entries carry their authoritative mount path.
- Root explorer and folder-picker navigation use `mountPath`, including when the display name differs. Mounted child navigation continues to append the child entry name.
- Added folder-level `upload` and `createFolder` capabilities. The native R2 entry tree grants them only to administrators on folders; virtual root and mount entries keep them disabled.
- The admin toolbar hides upload and create-folder controls when the current directory lacks those capabilities. Drag/drop and create-dialog dispatch use the same guards.
- List and grid selection checkboxes now require at least one mutation capability. Batch actions are derived only from mutable selected entries, so read-only mount folders cannot enter a batch operation.
- Shared Worker setup now applies migration `0010`. Focused filesystem/router tests no longer import or execute it manually, while a separate migration suite verifies shared setup and idempotent reapplication.

### RED Evidence

Commands:

```sh
npm run test:worker -- tests/worker/file-system.test.ts tests/worker/router.test.ts tests/worker/native-r2-migration.test.ts
npm run test:ui -- tests/ui/explorer.test.tsx tests/ui/operations.test.tsx
```

Observed Worker result before the fix: failed with exit code 1. The shared-setup assertion found no `native-r2` row, and virtual root returned no common `mountPath` field.

Observed UI result before the fix: failed with exit code 1. Explorer navigation opened `/Cold%20Storage` instead of `/archive`; virtual-root administrators still saw upload, create-folder, and mount selection controls; and the folder picker requested the display-name path instead of `/archive`.

### GREEN Evidence

Focused commands:

```sh
npm run test:worker -- tests/worker/file-system.test.ts tests/worker/router.test.ts tests/worker/native-r2-migration.test.ts
npm run test:ui -- tests/ui/explorer.test.tsx tests/ui/operations.test.tsx
```

Observed result: passed with exit code 0. Three Worker files with 25 tests passed, and two UI files with 6 tests passed.

Full verification:

```sh
npm run check
git diff --check
```

Observed result: passed with exit code 0. TypeScript and the production build passed; 14 Worker files with 115 tests passed; 7 UI files with 25 tests passed; and the whitespace check reported no errors.

### Fix Files

- Worker contract and serialization: `src/worker/types.ts`, `src/worker/entries.ts`, `src/worker/file-system.ts`.
- UI contract and navigation: `src/ui/types/entries.ts`, `src/ui/api/entries.ts`, `src/ui/app/ExplorerApp.tsx`, and `src/ui/features/operations/FolderPickerDialog.tsx`.
- Capability-based controls and selection: `src/ui/app/ExplorerApp.tsx`, `src/ui/features/explorer/ExplorerToolbar.tsx`, `src/ui/features/explorer/EntryRow.tsx`, and `src/ui/features/explorer/FileGrid.tsx`.
- Migration setup and coverage: `tests/worker/setup.ts`, `tests/worker/native-r2-migration.test.ts`, `tests/worker/file-system.test.ts`, and `tests/worker/router.test.ts`.
- UI coverage and typed fixtures: `tests/ui/explorer.test.tsx`, `tests/ui/operations.test.tsx`, and `tests/ui/preview.test.tsx`.

### Fix Concerns

- Non-native mounted-path provider dispatch remains intentionally deferred and still returns `DRIVER_UNAVAILABLE`; virtual-root listing remains provider-independent.
- Test runners retain the existing non-failing process-secret and Node localStorage warnings.

### Fix Commit

`fix: address virtual mount review findings` (hash reported in the task handoff).

## P2 Fix Review

### Finding Resolved

- `FolderPickerDialog` now derives destination eligibility from the current folder's `move`, `upload`, and `createFolder` capabilities. A folder is eligible when at least one of those write capabilities is available.
- The `Move here` control is disabled at the virtual root and at any other current folder where all three capabilities are false.
- The submit handler enforces the same capability check, so a read-only destination cannot be submitted by bypassing the disabled control.
- Navigation into mount entries remains available. After entering a writable mount, `Move here` becomes enabled and submits the mounted folder's entry ID.

### RED Evidence

Command:

```sh
npm run test:ui -- tests/ui/operations.test.tsx
```

Observed result before the fix: failed with exit code 1. The production-shaped response used `current.id = 'virtual-root'` with `move`, `upload`, and `createFolder` all false, but the `Move here` button was still enabled.

### GREEN Evidence

Focused command:

```sh
npm run test:ui -- tests/ui/operations.test.tsx
```

Observed result: passed with exit code 0; 1 UI file with 5 tests passed. The new test confirms no submission at the read-only virtual root, then enters `/archive`, enables the destination action, and submits `archive-root`.

Full UI command:

```sh
npm run test:ui
```

Observed result: passed with exit code 0; 7 UI files with 26 tests passed.

Full verification:

```sh
npm run check
git diff --check
```

Observed result: passed with exit code 0. TypeScript and the production build passed; 14 Worker files with 115 tests passed; 7 UI files with 26 tests passed; and the whitespace check reported no errors.

### P2 Fix Files

- `src/ui/features/operations/FolderPickerDialog.tsx`: applies capability-derived destination eligibility to both the action state and submit guard.
- `tests/ui/operations.test.tsx`: covers the read-only virtual-root response and successful navigation into a writable `/archive` mount.

### P2 Fix Concerns

- Test runners retain the existing non-failing process-secret and Node localStorage warnings.

### P2 Fix Commit

`fix: guard virtual move destinations` (hash reported in the task handoff).
