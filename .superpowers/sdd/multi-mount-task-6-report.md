# Task 6: AWS Signature V4 and S3 HTTP Client Report

## Status

Implemented Task 6 on `feat/ilist-core-file-manager`. The implementation provides Workers-compatible SigV4 signing, structured S3 XML parsing, path-style and virtual-hosted requests, list pagination, all requested object operations, and streamed successful response bodies.

## RED Evidence

Initial focused command:

```sh
npm run test:worker -- tests/worker/s3-signing.test.ts tests/worker/s3-client.test.ts
```

Observed result before implementation: failed with exit code 1. Both suites failed to load because `src/worker/drivers/s3/signing.ts` and `src/worker/drivers/s3/client.ts` did not exist; 2 test files failed and no tests were collected.

Canonical-query regression command:

```sh
npm run test:worker -- tests/worker/s3-signing.test.ts
```

Observed result before the fix: failed with exit code 1; 1 of 4 tests failed. Locale collation produced `%C3%A9=3&lower=1&same=A&same=z&Upper=2`, while SigV4 encoded byte order requires `%C3%A9=3&Upper=2&lower=1&same=A&same=z`.

Embedded CopyObject-error command:

```sh
npm run test:worker -- tests/worker/s3-client.test.ts
```

Observed result before the fix: failed with exit code 1; 1 of 5 tests failed. `copyObject()` resolved an HTTP 200 response containing `<Error>` instead of rejecting it, which could allow a later copy-before-delete move to delete the source after a failed copy.

## GREEN Evidence

Required focused and full Worker command:

```sh
npm run test:worker -- tests/worker/s3-signing.test.ts tests/worker/s3-client.test.ts && npm run test:worker
```

Observed result: passed with exit code 0. The focused run passed 2 files and 9 tests; the complete Worker run passed 16 files and 124 tests.

Final project verification:

```sh
npm run check && npm audit --omit=dev && git diff --check
```

Observed result: passed with exit code 0. TypeScript and the production build passed; 16 Worker files with 124 tests passed; 7 UI files with 26 tests passed; the production dependency audit found 0 vulnerabilities; and the whitespace check reported no errors.

## Files

- `src/worker/drivers/s3/signing.ts`: Web Crypto HMAC-SHA256 SigV4 signing, AWS URI encoding, canonical URI/query/header construction, temporary credential support, and deterministic signing time injection.
- `src/worker/drivers/s3/xml.ts`: validated structured XML parsing for list results and S3 errors, with normalized object/prefix collections and opaque string continuation tokens.
- `src/worker/drivers/s3/client.ts`: injectable HTTP client with path and virtual addressing, list/head/get/put/copy/delete operations, streamed successful responses, and structured failure handling.
- `tests/worker/s3-signing.test.ts`: AWS-published fixed GET Object vector plus Unicode URI, duplicate query, encoded byte ordering, whitespace, double-slash, and temporary credential coverage.
- `tests/worker/s3-client.test.ts`: encoded list requests, continuation tokens, common prefixes, malformed/error XML, every object method, streaming bodies, and HTTP 200 CopyObject errors.
- `package.json` and `package-lock.json`: add `fast-xml-parser` 5.10.0; no AWS SDK is present.
- `.superpowers/sdd/multi-mount-task-6-report.md`: this report.

## Commit

`feat: add s3 compatible client` (hash reported in the task handoff).

## Self-Review

- The official AWS S3 GET Object vector produces authorization signature `f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`.
- Signing uses only Web Crypto `subtle.digest`, `subtle.importKey`, and `subtle.sign`; request payloads are not buffered and the AWS SDK is not installed.
- Canonical paths encode UTF-8 bytes once and preserve slash boundaries; queries preserve duplicates and empty values and sort encoded names/values by byte-compatible code-unit order; headers are lowercased, sorted, trimmed, and whitespace-collapsed.
- List query values use `URLSearchParams`, so Unicode prefixes and opaque continuation tokens round trip without manual concatenation or token interpretation.
- XML is validated and parsed with a structured parser. No regular expression is used to parse XML; numeric regular expressions validate already parsed numeric fields only.
- Successful `getObject()`, `headObject()`, `putObject()`, and `deleteObject()` responses are returned unchanged. `copyObject()` reads a clone only to detect S3's HTTP 200 `<Error>` case, leaving a valid original response unconsumed.
- Error objects expose stable status, code, message, resource, and request ID fields without retaining raw XML, `HostId`, credentials, or provider response bodies.
- The diff is confined to Task 6 implementation, tests, dependency manifests, and this report. Existing drivers, registry, routes, migrations, and unrelated files were not changed.

## Concerns

- Worker tests emit existing non-failing warnings that process-environment secrets are absent even though deterministic Vitest Worker bindings provide them. UI tests emit the existing Node experimental localStorage warning. All verification commands pass.
- No live S3-compatible endpoint was contacted; provider calls are covered with deterministic fetch fakes as required by the approved design. Production smoke testing remains a rollout activity.
