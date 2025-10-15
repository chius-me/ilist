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

## Fix Review Takeover (2026-07-13)

### Status

Took over the uncommitted partial review patch in `client.ts`, `signing.ts`, `xml.ts`, and the S3 tests without discarding it. Completed all six review findings and added strict rejection for blank required fields in both successful and embedded-error CopyObject XML.

### RED Evidence

The inherited partial patch initially passed its focused suite with 18 tests. To verify that the inherited regression tests detect the reviewed behavior, only the three production-file changes were temporarily reversed against `d2fa81e` while retaining the inherited tests, then restored before continuing:

```sh
npm run test:worker -- tests/worker/s3-signing.test.ts tests/worker/s3-client.test.ts
```

Observed result against the pre-fix production code: failed with exit code 1; 2 test files failed, with 11 failed and 7 passed tests. Failures covered normalized `.`/`..` keys in both addressing modes, missing `encoding-type=url`, absent one-time decoding and namespace support, trimmed opaque values, permissive CopyObject success parsing, namespace-prefixed embedded errors, and raw `+` being canonicalized as a space.

An additional strict CopyObject validation cycle was captured after restoring the inherited patch:

```sh
npm run test:worker -- tests/worker/s3-client.test.ts
```

Observed RED result: failed with exit code 1; 1 of 15 tests failed because a blank embedded `<Error>` produced an empty-message `S3Error` instead of rejecting malformed XML. After requiring non-empty trimmed `Code`, `Message`, `ETag`, and `LastModified` scalars, the focused suite passed.

### Fixes

- Preserved period-only object-key segments as `%2E` and `%2E%2E`, built request targets as raw strings, and signed/sent those strings without an intermediate `URL` or `Request` normalization step.
- Required every HTTP 200 CopyObject body to parse as either a complete `CopyObjectResult` or a structured `Error`; empty, malformed, unknown, truncated, and blank-required-field bodies now fail closed.
- Disabled global XML value trimming so object keys, common prefixes, and opaque continuation tokens retain exact leading, trailing, and embedded spaces; numeric/control/error fields are trimmed only where their schema requires it.
- Added `encoding-type=url` to every ListObjectsV2 request and URL-decoded only documented key fields once, leaving continuation tokens opaque.
- Canonicalized queries from the raw query string so literal `+`, `%2B`, and `%20` remain distinguishable before AWS encoding and encoded-name/value sorting.
- Enabled namespace-prefix removal in the structured XML parser and covered prefixed list, copy-result, and error documents.

### Verification

```sh
npm run test:worker -- tests/worker/s3-signing.test.ts tests/worker/s3-client.test.ts
npm run check
npm audit
git diff --check
```

Observed results before commit:

- Focused S3 run: exit code 0; 2 files and 20 tests passed.
- Full check: exit code 0; TypeScript and production build passed, 16 Worker files with 135 tests passed, and 7 UI files with 26 tests passed.
- Dependency audit: exit code 0; 0 vulnerabilities.
- Diff check: exit code 0; no whitespace errors.

### Self-Review

- The outgoing request URL and SigV4 canonical request are derived from the same unnormalized string, including period-only key segments and raw query bytes.
- List result decoding is gated by the response `EncodingType` marker and applies only to `Key` and `CommonPrefixes/Prefix`, which are the documented fields exposed by the current result interface. `NextContinuationToken` is never trimmed or decoded.
- CopyObject validates a cloned body so successful callers still receive the original unconsumed response, while an embedded error becomes a structured `S3Error` with no raw XML or `HostId` exposure.
- Namespace handling remains structured through `fast-xml-parser`; no XML regular-expression parsing was introduced.
- The final diff is limited to the three S3 implementation files, two S3 test files, and this Task 6 report.

### Concerns

- Verification retains the existing non-failing missing process-secret warnings in Worker tests and Node experimental localStorage warnings in UI tests.
- No live S3-compatible endpoint was contacted; deterministic fetch fakes cover the reviewed wire behavior, and provider smoke testing remains a rollout activity.
