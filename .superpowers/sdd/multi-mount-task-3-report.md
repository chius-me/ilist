# Task 3: Common Driver Contract and Mount Resolver Report

## Status

Implemented Task 3. The commit is recorded below.

## RED Evidence

Command:

```sh
npm run test:worker -- tests/worker/mount-resolver.test.ts
```

Observed result: failed with exit code 1 before implementation. Vitest could not import `../../src/worker/mount-resolver` because the Task 3 resolver module did not exist. No tests collected, which proved the requested API was absent.

## GREEN Evidence

Focused command:

```sh
npm run test:worker -- tests/worker/mount-resolver.test.ts
```

Observed result: passed with exit code 0: 1 test file and 5 tests passed.

Final verification:

```sh
npm run test:worker -- tests/worker/mount-resolver.test.ts && npm run test:worker && npx tsc --noEmit && git diff --check
```

Observed result: passed with exit code 0. The focused suite passed 1 file and 5 tests; the complete Worker suite passed 12 files and 100 tests. TypeScript and whitespace checks completed without errors.

## Files

- `src/worker/drivers/types.ts`: adds the provider-neutral storage driver contract, item/list/download types, capabilities, factory signature, and registry type.
- `src/worker/drivers/registry.ts`: adds the empty driver registry and `createDriver()`, which loads decrypted credentials only after confirming a factory is available.
- `src/worker/mount-resolver.ts`: resolves decoded virtual path segments with exact top-level mount matching and stable mount errors.
- `tests/worker/mount-resolver.test.ts`: covers provider-relative path preservation, decoded matching, prefix rejection, disabled/missing mount errors, unavailable drivers, and factory inputs.
- `.superpowers/sdd/multi-mount-task-3-report.md`: this report.

## Commit

`feat: add storage driver contract`.

## Self-Review

- `StorageDriver` matches the approved design, including explicit read-only capabilities and all provider operations.
- The resolver decodes each virtual path segment, compares only the first decoded segment to a mount path, and returns a decoded provider-relative path.
- Resolver failures use only `MOUNT_NOT_FOUND` and `MOUNT_DISABLED`; registry failures use `DRIVER_UNAVAILABLE`.
- Driver factories receive exactly `(env, mount, decryptedCredentials)` and are not called when no factory is registered.
- No S3, OneDrive, router, file-system, schema, or existing Task 1/2 files were changed.

## Concerns

- S3 and OneDrive factories remain intentionally unregistered; `createDriver()` returns `DRIVER_UNAVAILABLE` until their later tasks add implementations.
- The Worker test runner emitted non-failing warnings about process-environment secrets. The Worker test configuration supplies deterministic bindings, and all tests passed.
