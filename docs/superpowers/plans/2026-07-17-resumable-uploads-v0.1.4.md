# ilist v0.1.4 Resumable Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one consistent, secure large-file upload workflow for OneDrive Personal and S3-compatible mounts, with in-page pause, resume, retry, cancel, and accurate progress.

**Architecture:** Preserve the existing single-request upload route for files below `10 MiB` and native R2 compatibility uploads. Add a server-owned upload-session service for OneDrive and S3-compatible mounts; encrypted provider state and completed-part metadata live in D1, while browsers receive only an ilist session ID. The React upload queue chooses the session transport for files at or above `10 MiB`, sends sequential `10 MiB` parts, and still limits file-level concurrency to two.

**Tech Stack:** Cloudflare Workers native `fetch`, TypeScript, D1, Web Crypto AES-GCM, Microsoft Graph upload sessions, S3 multipart upload with Signature V4, React 19, XMLHttpRequest, Vitest Workers pool, Testing Library, Playwright.

## Global Constraints

- Release version is `v0.1.4`; do not introduce a major or minor version bump.
- `10 MiB` means exactly `10 * 1024 * 1024` bytes for both the threshold and part size.
- Files below `10 MiB` continue through the existing `/api/admin/files/:id` transport.
- OneDrive and S3-compatible files at or above `10 MiB` use provider upload sessions.
- Native R2 compatibility mounts retain their existing single-request behavior in this release.
- At most two files upload concurrently; parts within one file upload sequentially.
- Pause, resume, cancel, and retry are supported only while the current page remains open.
- Provider upload URLs, S3 upload IDs, credentials, and encrypted provider state never appear in browser responses or logs.
- Every upload-session mutation requires a valid administrator cookie, matching session ownership, and same-origin validation.
- Existing mounts, credentials, object rows, entry rows, and stable file links remain compatible.
- Do not add Hono, an ORM, Durable Objects, Queues, Workflows, or a new frontend state library.

---

## File Map

### New Worker Files

- `migrations/0012_upload_sessions.sql`: resumable-upload state and indexes.
- `src/worker/upload-session-store.ts`: typed D1 persistence, part claims, idempotency, and expiration queries.
- `src/worker/upload-service.ts`: provider-neutral validation and upload lifecycle orchestration.
- `src/worker/upload-routes.ts`: administrator HTTP contract for create, inspect, part, complete, and abort.
- `tests/worker/upload-session-store.test.ts`: D1 state-transition and ownership tests.
- `tests/worker/upload-service.test.ts`: provider-neutral lifecycle and validation tests.
- `tests/worker/upload-routes.test.ts`: end-to-end Worker route authorization and response tests.

### Modified Worker Files

- `src/worker/auth.ts`: expose the authenticated D1 session ID without exposing the cookie token.
- `src/worker/types.ts`: add session and optional multipart capability types.
- `src/worker/drivers/types.ts`: define the provider-neutral resumable adapter.
- `src/worker/drivers/s3/xml.ts`: parse multipart-create and multipart-complete XML.
- `src/worker/drivers/s3/client.ts`: send create, upload-part, complete, and abort S3 operations.
- `src/worker/drivers/s3/driver.ts`: implement the resumable adapter within mount root boundaries.
- `src/worker/drivers/onedrive/client.ts`: create and use Graph upload sessions without leaking upload URLs.
- `src/worker/drivers/onedrive/driver.ts`: implement the resumable adapter and scope validation.
- `src/worker/external-entries.ts`: expose multipart support on writable external folders.
- `src/worker/router.ts`: dispatch upload-session routes after administrator authentication.
- `tests/worker/setup.ts`: apply migration `0012` to every Worker test database.
- Existing S3, OneDrive, router, and multi-mount test files: cover provider and regression behavior.

### Modified Frontend Files

- `src/ui/api/uploads.ts`: small-upload and resumable-upload transports.
- `src/ui/features/uploads/upload-reducer.ts`: resumable task state and transitions.
- `src/ui/features/uploads/useUploadQueue.ts`: threshold selection, sequential parts, pause/resume, retry, cancel, and two-file scheduling.
- `src/ui/features/uploads/UploadPanel.tsx`: pass pause/resume actions and count resumable active states.
- `src/ui/features/uploads/UploadTaskRow.tsx`: accessible controls and part-aware status.
- `src/ui/app/ExplorerPage.tsx`: pass current-directory multipart capability to the queue.
- `src/ui/types/entries.ts`: add optional `multipartUpload` directory capability.
- `src/ui/i18n/messages.ts`: English and Simplified Chinese upload-session copy.
- `src/ui/i18n/apiErrors.ts`: stable localized upload-session errors.
- `src/ui/styles/overlays.css`: stable upload-task control layout.
- `tests/ui/uploads.test.tsx`: reducer, scheduler, and interaction coverage.
- `tests/ui/responsive-and-accessibility.test.tsx`: keyboard labels and touch-target coverage.
- `tests/e2e/fixtures.ts` and `tests/e2e/web-ui.spec.ts`: deterministic resumable upload browser scenarios.

### Release Files

- `README.md`, `README.zh.md`, and `package.json`/`package-lock.json`: capability, limitation, operation, and version updates.

---

### Task 1: Define the Resumable Driver Contract

**Files:**
- Modify: `src/worker/drivers/types.ts`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/external-entries.ts`
- Modify: `tests/worker/multi-mount-integration.test.ts`

**Interfaces:**
- Produces: `UPLOAD_PART_SIZE_BYTES`, `LARGE_UPLOAD_THRESHOLD_BYTES`, `CompletedUploadPart`, `ProviderUploadSession`, `ProviderUploadPartResult`, `ResumableUploadAdapter`, and `requireResumableUploadAdapter(driver)`.
- Produces: optional `EntryCapabilities.multipartUpload` for frontend transport selection.
- Consumes: existing `StorageDriver`, `StorageItem`, and external-entry capability mapping.

- [ ] **Step 1: Write failing contract tests**

Extend the fake drivers in `tests/worker/multi-mount-integration.test.ts` with one S3/OneDrive resumable adapter and assert that an administrator folder response contains `capabilities.multipartUpload: true`, while native R2 and public responses do not expose an enabled multipart action.

```ts
expect(folder.capabilities).toMatchObject({
  upload: true,
  multipartUpload: true,
});
expect(nativeRoot.capabilities.multipartUpload).toBe(false);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run test:worker -- tests/worker/multi-mount-integration.test.ts`

Expected: FAIL because `multipartUpload` and the resumable adapter contract do not exist.

- [ ] **Step 3: Add exact common types and constants**

Add this contract to `src/worker/drivers/types.ts`:

```ts
export const LARGE_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_PART_SIZE_BYTES = 10 * 1024 * 1024;

export interface CompletedUploadPart {
  partNumber: number;
  size: number;
  etag: string | null;
}

export interface ProviderUploadSession {
  state: Record<string, unknown>;
  expiresAt: number;
}

export interface ProviderUploadPartResult {
  state?: Record<string, unknown>;
  part: CompletedUploadPart;
  completedItem?: StorageItem;
}

export interface ResumableUploadAdapter {
  create(input: {
    parentId: string;
    name: string;
    size: number;
    contentType: string | null;
    partSize: number;
  }): Promise<ProviderUploadSession>;
  uploadPart(input: {
    state: Record<string, unknown>;
    partNumber: number;
    offset: number;
    totalSize: number;
    body: ReadableStream;
    size: number;
    signal: AbortSignal;
  }): Promise<ProviderUploadPartResult>;
  complete(input: {
    state: Record<string, unknown>;
    parts: CompletedUploadPart[];
    completedItem?: StorageItem;
  }): Promise<StorageItem>;
  abort(state: Record<string, unknown>): Promise<void>;
}
```

Add `'multipartUpload'` to `DriverCapability`, add `readonly resumableUpload?: ResumableUploadAdapter` to `StorageDriver`, and implement a type guard that requires both the capability and adapter. Add `multipartUpload?: boolean` to `EntryCapabilities`; set it to true only for authenticated writable folders whose driver passes the guard, and false for virtual/native/public-only folders.

- [ ] **Step 4: Run contract and type tests**

Run: `npm run test:worker -- tests/worker/multi-mount-integration.test.ts && npx tsc --noEmit`

Expected: PASS, with all existing fake drivers remaining valid because the adapter is optional.

- [ ] **Step 5: Commit**

```bash
git add src/worker/drivers/types.ts src/worker/types.ts src/worker/external-entries.ts tests/worker/multi-mount-integration.test.ts
git commit -m "feat: define resumable upload driver contract"
```

---

### Task 2: Add S3 Multipart Operations

**Files:**
- Modify: `src/worker/drivers/s3/xml.ts`
- Modify: `src/worker/drivers/s3/client.ts`
- Modify: `src/worker/drivers/s3/driver.ts`
- Modify: `tests/worker/s3-client.test.ts`
- Modify: `tests/worker/s3-driver.test.ts`

**Interfaces:**
- Consumes: `ResumableUploadAdapter` and `CompletedUploadPart` from Task 1.
- Produces: `S3Client.createMultipartUpload`, `uploadPart`, `completeMultipartUpload`, and `abortMultipartUpload`.
- Produces: `S3Driver.resumableUpload` with provider state `{ key, uploadId, parentId, contentType }`.

- [ ] **Step 1: Write failing S3 client tests**

Add tests that verify exact signed request shapes:

```ts
await client.createMultipartUpload('中文/archive.bin', 'application/octet-stream');
await client.uploadPart('中文/archive.bin', 'upload-123', 1, partBody);
await client.completeMultipartUpload('中文/archive.bin', 'upload-123', [
  { partNumber: 1, size: 10 * 1024 * 1024, etag: '"etag-1"' },
]);
await client.abortMultipartUpload('中文/archive.bin', 'upload-123');
```

Assert `POST ?uploads`, `PUT ?partNumber=1&uploadId=...`, ordered completion XML with escaped ETags, and `DELETE ?uploadId=...`. Assert upload-part fails when the response omits `ETag`, and XML parsers reject malformed or missing `UploadId`.

- [ ] **Step 2: Run S3 client tests and verify failure**

Run: `npm run test:worker -- tests/worker/s3-client.test.ts`

Expected: FAIL because multipart methods and XML parsers are missing.

- [ ] **Step 3: Implement S3 client operations**

Add strongly typed methods:

```ts
createMultipartUpload(key: string, contentType: string | null): Promise<{ uploadId: string }>;
uploadPart(key: string, uploadId: string, partNumber: number, body: BodyInit): Promise<{ etag: string }>;
completeMultipartUpload(key: string, uploadId: string, parts: CompletedUploadPart[]): Promise<Response>;
abortMultipartUpload(key: string, uploadId: string): Promise<Response>;
```

Use existing `requestUrl`, SigV4 signing, `encodeS3Component`, and `send`. Sort completion parts by `partNumber`; XML-escape each ETag; reject duplicate or non-positive part numbers before issuing a request. Parse S3 error-shaped `200` completion bodies the same way `copyObject` already does.

- [ ] **Step 4: Write failing S3 driver adapter tests**

Cover root-prefix isolation, validated target names, `10 MiB` parts, ETag propagation, ordered completion, final stat mapping, abort, and invalid provider-state rejection.

```ts
const session = await driver.resumableUpload!.create({
  parentId: driver.rootId,
  name: 'archive.bin',
  size: 20 * 1024 * 1024,
  contentType: 'application/octet-stream',
  partSize: 10 * 1024 * 1024,
});
expect(session.state).toMatchObject({ key: 'tenant/root/archive.bin', uploadId: 'upload-123' });
```

- [ ] **Step 5: Implement the S3 adapter**

Add `'multipartUpload'` to S3 capabilities. Validate all serialized state fields before use. Use a 24-hour ilist expiration for S3 sessions, while allowing S3 lifecycle rules to remain the provider-side cleanup backstop. `complete` calls S3 complete, then `headObject`, and returns the same `StorageItem` shape as ordinary upload.

- [ ] **Step 6: Run focused S3 tests**

Run: `npm run test:worker -- tests/worker/s3-client.test.ts tests/worker/s3-driver.test.ts`

Expected: PASS for all ordinary and multipart S3 behavior.

- [ ] **Step 7: Commit**

```bash
git add src/worker/drivers/s3/xml.ts src/worker/drivers/s3/client.ts src/worker/drivers/s3/driver.ts tests/worker/s3-client.test.ts tests/worker/s3-driver.test.ts
git commit -m "feat: add s3 multipart upload adapter"
```

---

### Task 3: Add OneDrive Upload Sessions

**Files:**
- Modify: `src/worker/drivers/onedrive/client.ts`
- Modify: `src/worker/drivers/onedrive/driver.ts`
- Modify: `tests/worker/onedrive-driver.test.ts`

**Interfaces:**
- Consumes: `ResumableUploadAdapter` from Task 1 and existing OneDrive token refresh behavior.
- Produces: `OneDriveClient.createUploadSession`, `uploadSessionPart`, `getUploadSessionStatus`, and `cancelUploadSession`.
- Produces: `OneDriveDriver.resumableUpload` with state `{ uploadUrl, expirationDateTime, parentId, name, contentType }` retained only server-side.

- [ ] **Step 1: Write failing OneDrive client tests**

Test the Graph control request and unauthenticated upload URL data requests:

```ts
const session = await client.createUploadSession('root', '中文 video.mp4');
const result = await client.uploadSessionPart(
  session.uploadUrl,
  new ReadableStream(),
  'bytes 0-10485759/20971520',
  10 * 1024 * 1024,
);
```

Assert that create uses Graph authorization and conflict behavior `fail`; part upload uses the HTTPS upload URL without a bearer token; intermediate `202` parses `nextExpectedRanges`; final `200/201` parses `GraphDriveItem`; `GET` status and `DELETE` cancel work; non-HTTPS upload URLs and malformed expiration values are rejected.

- [ ] **Step 2: Run the OneDrive tests and verify failure**

Run: `npm run test:worker -- tests/worker/onedrive-driver.test.ts`

Expected: FAIL because upload-session methods are missing.

- [ ] **Step 3: Implement safe OneDrive upload-session requests**

Add these response types:

```ts
interface GraphUploadSession {
  uploadUrl: string;
  expirationDateTime: string;
  nextExpectedRanges?: string[];
}

type GraphUploadPartResult =
  | { completed: false; nextExpectedRanges: string[] }
  | { completed: true; item: GraphDriveItem };
```

Create sessions through `requestJson`, but send part/status/cancel requests through a separate helper that accepts only an upload URL returned by Graph, requires HTTPS, never adds authorization, never logs query strings, and normalizes `404`, `409`, `416`, `429`, and `5xx` into upload-session error codes. Forward `Retry-After` in `HttpError.details` when present.

- [ ] **Step 4: Write failing OneDrive adapter tests**

Cover mount-root scope validation, exact byte range calculation, intermediate part result, final-item capture, completion from the captured item, abort, and expired or malformed serialized state.

```ts
expect(await adapter.uploadPart({
  state: session.state,
  partNumber: 2,
  offset: 10 * 1024 * 1024,
  totalSize: 15 * 1024 * 1024,
  body,
  size: 5 * 1024 * 1024,
  signal: new AbortController().signal,
})).toMatchObject({ part: { partNumber: 2, size: 5 * 1024 * 1024 } });
```

- [ ] **Step 5: Implement the OneDrive adapter**

Add `'multipartUpload'` to OneDrive capabilities. Validate target and parent scope before session creation. Build `Content-Range` from trusted service inputs, return an ETag of `null` for accepted intermediate parts, include `completedItem` only on Graph's final response, and require that item in `complete`. Cancellation calls Graph's upload-session delete endpoint.

- [ ] **Step 6: Run focused OneDrive tests**

Run: `npm run test:worker -- tests/worker/onedrive-driver.test.ts tests/worker/onedrive-tokens.test.ts`

Expected: PASS, including all pre-existing token refresh and CRUD cases.

- [ ] **Step 7: Commit**

```bash
git add src/worker/drivers/onedrive/client.ts src/worker/drivers/onedrive/driver.ts tests/worker/onedrive-driver.test.ts
git commit -m "feat: add onedrive upload session adapter"
```

---

### Task 4: Persist Encrypted Upload Sessions in D1

**Files:**
- Create: `migrations/0012_upload_sessions.sql`
- Create: `src/worker/upload-session-store.ts`
- Create: `tests/worker/upload-session-store.test.ts`
- Modify: `src/worker/auth.ts`
- Modify: `src/worker/types.ts`
- Modify: `tests/worker/setup.ts`

**Interfaces:**
- Produces: `AdminSession { id: string; user: AdminUser }`, `currentAdminSession`, and `requireAdminSession`.
- Produces: `UploadSessionRow`, `UploadSessionRecord`, `createUploadSessionRecord`, `getOwnedUploadSession`, `claimUploadPart`, `recordUploadPart`, `releaseUploadPartClaim`, `claimCompletion`, `completeUploadSessionRecord`, `markUploadSessionAborted`, and `listExpiredUploadSessions`.
- Consumes: `encryptCredential`/`decryptCredential` with additional-data context `upload-session:<id>`.

- [ ] **Step 1: Write migration and failing store tests**

Create `0012_upload_sessions.sql` with exact constraints:

```sql
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  parent_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT,
  part_size INTEGER NOT NULL CHECK (part_size > 0),
  provider_state_ciphertext TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  completed_item_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completing', 'completed', 'aborted')),
  active_part_number INTEGER,
  active_part_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_owner_status
ON upload_sessions(owner_session_id, status, updated_at);

CREATE INDEX IF NOT EXISTS upload_sessions_expiration
ON upload_sessions(status, expires_at);
```

Import it from `tests/worker/setup.ts`. Tests must prove owner isolation, provider-state encryption, completed-part JSON validation, one active part claim, expired claim takeover, duplicate completed-part idempotency, ordered parts, completion state transitions, and cascade cleanup after administrator session or mount deletion.

- [ ] **Step 2: Run store tests and verify failure**

Run: `npm run test:worker -- tests/worker/upload-session-store.test.ts`

Expected: FAIL because the store and authenticated session identity do not exist.

- [ ] **Step 3: Expose authenticated session identity**

Refactor authentication around:

```ts
export interface AdminSession {
  id: string;
  user: AdminUser;
}

export async function currentAdminSession(env: Env, request: Request): Promise<AdminSession | null>;
export async function requireAdminSession(env: Env, request: Request): Promise<AdminSession>;
```

Keep `currentUser` and `requireAdmin` as compatibility wrappers. Never return `id` from `/api/admin/me`; it is internal ownership data only.

- [ ] **Step 4: Implement the store with compare-and-set transitions**

Encrypt provider state using:

```ts
const context = `upload-session:${id}`;
const ciphertext = await encryptCredential(providerState, env.CREDENTIAL_MASTER_KEY, context);
```

Use conditional D1 updates for part claims and completion. A part claim succeeds only when the session is active and no non-expired claim exists. `recordUploadPart` verifies the claimed part, appends or returns the matching recorded part, saves updated encrypted provider state and optional completed item, then clears the claim. Reject a duplicate part with a different size or ETag.

- [ ] **Step 5: Run store, authentication, and migration tests**

Run: `npm run test:worker -- tests/worker/upload-session-store.test.ts tests/worker/router.test.ts tests/worker/mounts-schema.test.ts`

Expected: PASS with existing login and `/api/admin/me` output unchanged.

- [ ] **Step 6: Commit**

```bash
git add migrations/0012_upload_sessions.sql src/worker/upload-session-store.ts src/worker/auth.ts src/worker/types.ts tests/worker/upload-session-store.test.ts tests/worker/setup.ts
git commit -m "feat: persist encrypted upload sessions"
```

---

### Task 5: Implement Upload Lifecycle Service and Routes

**Files:**
- Create: `src/worker/upload-service.ts`
- Create: `src/worker/upload-routes.ts`
- Create: `tests/worker/upload-service.test.ts`
- Create: `tests/worker/upload-routes.test.ts`
- Modify: `src/worker/router.ts`
- Modify: `tests/worker/multi-mount-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 adapter, Task 4 store, `resolveExternalEntry`, `validateEntryName`, and `requireAdminSession`.
- Produces: safe API types `UploadSessionView`, `CreateUploadSessionBody`, and `UploadPartView`.
- Produces routes under `/api/admin/uploads/sessions`.

- [ ] **Step 1: Write failing service tests for validation and lifecycle**

Use a fake resumable driver and assert:

- only external OneDrive/S3 folders with multipart capability are accepted;
- declared size must be an integer at least `LARGE_UPLOAD_THRESHOLD_BYTES` and within `Number.MAX_SAFE_INTEGER`;
- `partSize` is fixed server-side and cannot be supplied by the client;
- expected part length is exactly `min(partSize, size - offset)`;
- parts are numbered from 1 through `Math.ceil(size / partSize)`;
- completion requires every part exactly once;
- abort is idempotent;
- expired sessions reject new parts and are eligible for best-effort upstream abort.

Expected safe create response:

```ts
{
  id: expect.any(String),
  kind: 'multipart',
  partSize: 10 * 1024 * 1024,
  size: 25 * 1024 * 1024,
  uploadedParts: [],
  expiresAt: expect.any(String),
  status: 'active',
}
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm run test:worker -- tests/worker/upload-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement lifecycle orchestration**

Create service functions:

```ts
createResumableUpload(env, ownerSessionId, input): Promise<UploadSessionView>;
getResumableUpload(env, ownerSessionId, id): Promise<UploadSessionView>;
uploadResumablePart(env, ownerSessionId, id, partNumber, request): Promise<UploadPartView>;
completeResumableUpload(env, ownerSessionId, id): Promise<{ entry: MountEntry }>;
abortResumableUpload(env, ownerSessionId, id): Promise<void>;
cleanupExpiredUploads(env, limit?: number): Promise<void>;
```

Before forwarding a part, require an exact numeric `Content-Length`, ensure the request body exists, claim that part for five minutes, and pass `request.signal` to provider fetch calls. On provider failure release the claim unless ownership was lost. Run cleanup with a limit of ten at the beginning of session creation; cleanup failures must not block a new upload.

- [ ] **Step 4: Write failing route tests**

Test the exact HTTP contract:

```text
POST   /api/admin/uploads/sessions
GET    /api/admin/uploads/sessions/:id
PUT    /api/admin/uploads/sessions/:id/parts/:partNumber
POST   /api/admin/uploads/sessions/:id/complete
DELETE /api/admin/uploads/sessions/:id
```

Assert authentication, same-origin protection, cross-session isolation, invalid JSON, encoded parent IDs, missing `Content-Length`, wrong part lengths, duplicate retry, busy claim, completion, cancellation, expired session, and no provider-state fields in any JSON response.

- [ ] **Step 5: Implement and register routes**

Have `handleAdmin` call `requireAdminSession` once, retain `session.user` for `/api/admin/me`, and invoke:

```ts
const uploadResponse = await handleUploadRoutes(request, env, url, session.id);
if (uploadResponse) return uploadResponse;
```

Use `ok(...)` and `noContent()` consistently. Return stable codes including `UPLOAD_SESSION_UNSUPPORTED`, `UPLOAD_SESSION_NOT_FOUND`, `UPLOAD_SESSION_EXPIRED`, `UPLOAD_PART_INVALID`, `UPLOAD_PART_BUSY`, `UPLOAD_INCOMPLETE`, and provider-specific retryable codes.

- [ ] **Step 6: Run service, route, and regression tests**

Run: `npm run test:worker -- tests/worker/upload-service.test.ts tests/worker/upload-routes.test.ts tests/worker/multi-mount-integration.test.ts tests/worker/router.test.ts`

Expected: PASS; existing small uploads continue to call `driver.upload` and native R2 remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/worker/upload-service.ts src/worker/upload-routes.ts src/worker/router.ts tests/worker/upload-service.test.ts tests/worker/upload-routes.test.ts tests/worker/multi-mount-integration.test.ts
git commit -m "feat: expose resumable upload api"
```

---

### Task 6: Build the Frontend Resumable Transport

**Files:**
- Modify: `src/ui/api/uploads.ts`
- Modify: `src/ui/types/entries.ts`
- Modify: `tests/ui/uploads.test.tsx`

**Interfaces:**
- Consumes: Worker API from Task 5.
- Produces: `UploadTransport`, `uploadSmallFile`, `createUploadSession`, `uploadSessionPart`, `completeUploadSession`, `abortUploadSession`, and `uploadFile` coordinator.
- Produces progress callbacks with committed bytes plus active-part bytes.

- [ ] **Step 1: Write failing transport tests**

Mock `fetch` and `XMLHttpRequest` to prove:

- a `10 MiB - 1` file uses the existing single request;
- an exact `10 MiB` file on a multipart-capable folder creates a session;
- a `25 MiB` file sends `10 MiB`, `10 MiB`, and `5 MiB` Blob slices sequentially;
- every Blob part causes the browser to derive the exact `Content-Length` and sends the original content type;
- completion occurs only after all parts succeed;
- a failed second part retries without resending part one;
- cancellation calls the server abort route;
- safe API responses contain no provider URL or upload ID assumptions.

- [ ] **Step 2: Run upload API tests and verify failure**

Run: `npm run test:ui -- tests/ui/uploads.test.tsx`

Expected: FAIL because only the single XHR transport exists.

- [ ] **Step 3: Implement the transport coordinator**

Use these shared frontend types:

```ts
export interface UploadSessionView {
  id: string;
  kind: 'multipart';
  partSize: number;
  size: number;
  uploadedParts: Array<{ partNumber: number; size: number }>;
  expiresAt: string;
  status: 'active' | 'completing' | 'completed' | 'aborted';
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partNumber?: number;
  partCount?: number;
}
```

Retain XHR for byte-level progress. For each part, create a new XHR so pause can abort only the current request. Send the sliced `Blob` directly and let the browser set the forbidden `Content-Length` header from the Blob size; do not call `setRequestHeader('content-length', ...)`. Calculate committed bytes from server-confirmed parts and add active XHR bytes only for display. The coordinator accepts a mutable control object or callbacks so the queue can pause between parts without losing the session ID.

- [ ] **Step 4: Run focused UI transport tests**

Run: `npm run test:ui -- tests/ui/uploads.test.tsx`

Expected: PASS for threshold, slicing, sequential order, retry, cancellation, and existing small upload behavior.

- [ ] **Step 5: Commit**

```bash
git add src/ui/api/uploads.ts src/ui/types/entries.ts tests/ui/uploads.test.tsx
git commit -m "feat: add resumable upload transport"
```

---

### Task 7: Add Pause, Resume, Retry, and Accessible Upload UI

**Files:**
- Modify: `src/ui/features/uploads/upload-reducer.ts`
- Modify: `src/ui/features/uploads/useUploadQueue.ts`
- Modify: `src/ui/features/uploads/UploadPanel.tsx`
- Modify: `src/ui/features/uploads/UploadTaskRow.tsx`
- Modify: `src/ui/app/ExplorerPage.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `src/ui/i18n/apiErrors.ts`
- Modify: `src/ui/styles/overlays.css`
- Modify: `tests/ui/uploads.test.tsx`
- Modify: `tests/ui/responsive-and-accessibility.test.tsx`

**Interfaces:**
- Consumes: Task 6 transport and current-directory `multipartUpload` capability.
- Produces: task states `queued | creating | uploading | paused | completing | completed | failed | cancelled`.
- Produces: queue actions `pause(id)`, `resume(id)`, `cancel(id)`, `retry(id)`, `remove(id)`, and `clearCompleted()`.

- [ ] **Step 1: Write failing reducer and scheduler tests**

Add exact state-transition coverage:

```ts
queued -> creating -> uploading -> paused -> uploading -> completing -> completed
uploading -> failed -> uploading
queued|creating|uploading|paused|failed -> cancelled
```

Assert that retry preserves `sessionId`, `uploadedParts`, and committed bytes for multipart tasks, while a failed small upload restarts from zero. Assert that paused tasks do not occupy either of the two file slots and resume re-enters the scheduler once.

- [ ] **Step 2: Run focused queue tests and verify failure**

Run: `npm run test:ui -- tests/ui/uploads.test.tsx`

Expected: FAIL because resumable states and controls are missing.

- [ ] **Step 3: Implement queue state and page-lifetime controls**

Expand `UploadTask` with:

```ts
sessionId?: string;
partNumber?: number;
partCount?: number;
uploadedParts?: number[];
transport: 'single' | 'multipart';
```

Keep `File` only in memory. Use one `AbortController` per running task. Pause aborts the current part with an internal pause reason and transitions to `paused` without calling server abort. Cancel aborts the request, calls the server abort endpoint when a session exists, and transitions to `cancelled`. Register `beforeunload` only while tasks are creating, uploading, paused, completing, or retryable with an active server session; remove it when no such task remains.

- [ ] **Step 4: Implement translated, accessible controls**

Add English and Chinese keys for creating session, current part, paused, completing, pause, resume, session expired, part retry, and leave-page warning. Add localized mappings for every stable upload error code. Use Lucide `Pause`, `Play`, `RotateCcw`, and `X` icons with tooltips and accessible names. Keep each icon button at a `48px` mobile touch target and prevent task text from resizing the panel.

- [ ] **Step 5: Add interaction and accessibility tests**

Render `UploadPanel` and prove pause/resume/cancel buttons invoke the right callbacks, status text is translated, progressbar values remain monotonic across part boundaries, keyboard focus remains on the replaced pause/resume control, and long Chinese names do not remove controls from the DOM.

- [ ] **Step 6: Run UI and type verification**

Run: `npm run test:ui -- tests/ui/uploads.test.tsx tests/ui/responsive-and-accessibility.test.tsx && npx tsc --noEmit`

Expected: PASS with English/Chinese dictionary parity and no existing explorer regression.

- [ ] **Step 7: Commit**

```bash
git add src/ui/features/uploads src/ui/app/ExplorerPage.tsx src/ui/i18n src/ui/styles/overlays.css tests/ui/uploads.test.tsx tests/ui/responsive-and-accessibility.test.tsx
git commit -m "feat: add resumable upload queue controls"
```

---

### Task 8: Complete Integration, Browser, and Visual Coverage

**Files:**
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/web-ui.spec.ts`
- Modify: `tests/e2e/web-ui.spec.ts-snapshots/*` only through Playwright snapshot updates.
- Modify: relevant Worker integration tests if full-suite regressions expose shared fake-driver assumptions.

**Interfaces:**
- Consumes: completed Worker and frontend upload workflow.
- Produces: deterministic browser fixtures for session create, part progress, pause, resume, retry, cancel, and complete.

- [ ] **Step 1: Add deterministic E2E upload-session fixtures**

Intercept the five upload-session routes. Return a three-part `25 MiB` session, delay part two so pause is observable, fail part two once with `UPLOAD_PROVIDER_RATE_LIMITED`, and record completion/abort calls. Do not use real provider credentials in browser tests.

- [ ] **Step 2: Add browser workflow assertions**

Cover:

1. enqueueing a large file;
2. entering multipart mode at the exact threshold;
3. progress through part one;
4. pausing and resuming part two;
5. retrying the injected failure without repeating part one;
6. completing and refreshing the current folder once;
7. cancelling a second upload and observing server abort;
8. seeing a leave-page warning only while resumable work remains.

- [ ] **Step 3: Add visual scenarios**

Capture upload panel states at `1440x900`, `834x1112`, and `390x844` for uploading, paused, failed/retryable, and completing. Inspect that filenames truncate, progress text remains readable, controls stay aligned, and no panel escapes the viewport in either theme.

- [ ] **Step 4: Run browser and visual tests**

Run: `npm run test:e2e`

Expected: all browser projects pass, with only explicitly mobile-only contracts skipped on non-mobile projects.

Run: `npm run test:visual`

Expected: all approved visual scenarios pass after intentional snapshots are reviewed.

- [ ] **Step 5: Run the complete local gate**

Run: `npm run check`

Expected: TypeScript, production build, all Worker tests, and all UI tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e tests/worker tests/ui
git commit -m "test: cover resumable upload workflows"
```

---

### Task 9: Document, Migrate, Deploy, and Release v0.1.4

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: all verified v0.1.4 behavior.
- Produces: operator instructions, stable production deployment, Git tag `v0.1.4`, and GitHub Release `ilist v0.1.4`.

- [ ] **Step 1: Update documentation and limitations**

Document the exact `10 MiB` threshold, `10 MiB` part size, two-file concurrency, page-session-only recovery, OneDrive/S3 support, native R2 compatibility limitation, required provider permissions, S3 incomplete multipart lifecycle recommendation, and D1 migration. Remove the README statements that OneDrive sessions and S3 multipart are unsupported.

- [ ] **Step 2: Bump package version without creating a tag**

Run: `npm version 0.1.4 --no-git-tag-version`

Expected: only `package.json` and `package-lock.json` version fields change.

- [ ] **Step 3: Run pre-deployment verification**

Run: `git diff --check && npm run check && npm run test:e2e && npm run test:visual`

Expected: all commands pass. Treat missing local secret warnings in isolated Worker tests as non-fatal only when the test bindings provide deterministic replacements.

- [ ] **Step 4: Back up production D1**

Run:

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-v0.1.4.sql
```

Expected: a non-empty SQL export outside the repository. Do not commit it.

- [ ] **Step 5: Apply the production migration**

Run: `npx wrangler d1 migrations apply ilist-db --remote`

Expected: migration `0012_upload_sessions.sql` applies successfully and no prior migration is reapplied.

- [ ] **Step 6: Deploy and smoke-test production**

Run: `npm run deploy`

Verify on `https://ilist.chius.workers.dev`:

- existing public browsing and private login;
- an existing OneDrive mount and existing S3/R2 mount;
- a small upload still uses the ordinary route;
- a test file at or above `10 MiB` uploads to OneDrive and S3;
- pause, resume, retry, cancel, completion, download, and delete;
- Chinese filename and exact final-part size;
- no provider upload URL or S3 upload ID appears in browser network response bodies or Worker logs.

- [ ] **Step 7: Commit release metadata**

```bash
git add README.md README.zh.md package.json package-lock.json
git commit -m "chore: release v0.1.4"
```

- [ ] **Step 8: Push and create the stable release**

```bash
git push origin main
gh release create v0.1.4 --target main --title "ilist v0.1.4" --notes-file /tmp/ilist-v0.1.4-release.md
```

The release notes must summarize resumable OneDrive uploads, S3 multipart uploads, UI controls, migration `0012`, native R2 compatibility limits, and the final test counts. The release must be neither draft nor prerelease.

- [ ] **Step 9: Verify publication state**

Run:

```bash
gh release view v0.1.4 --json tagName,name,isDraft,isPrerelease,publishedAt,url
git status -sb
git rev-parse HEAD
git rev-parse origin/main
```

Expected: `v0.1.4` is published, `isDraft` and `isPrerelease` are false, local `main` equals `origin/main`, and the worktree is clean.

---

## Plan Self-Review Checklist

- The plan implements only `v0.1.4`; sharing and Google Drive remain in later plans.
- OneDrive and S3 use one public ilist upload-session contract.
- Provider-specific state is encrypted and never returned to the browser.
- Every mutation is bound to the authenticated administrator session and same origin.
- Small uploads and native R2 compatibility behavior remain intact.
- Threshold, part size, concurrency, and page-lifetime recovery match the approved design exactly.
- Driver, store, service, route, frontend, accessibility, browser, migration, deployment, and release tests all have explicit tasks.
- No task depends on an undefined type or a later task's implementation.
