# ilist Upload, Sharing, and Google Drive Roadmap Design

## Summary

Extend ilist through three independently deployable `0.1.x` releases. Version `v0.1.4` adds resumable large-file uploads for OneDrive and S3-compatible mounts, `v0.1.5` adds controlled file and folder sharing, and `v0.1.6` adds a Google Drive driver. Each release builds on the same storage-driver and virtual-file-system boundaries and must remain compatible with existing mounts and data.

## Release Sequence

### v0.1.4: Resumable Uploads

- Keep the existing single-request upload path for files smaller than `10 MiB`.
- Use provider upload sessions for files greater than or equal to `10 MiB`.
- Use `10 MiB` parts, which satisfy OneDrive's `320 KiB` alignment and S3's minimum non-final part size.
- Support OneDrive upload sessions and S3 multipart uploads through one Worker API and one frontend queue.
- Support pause, resume, cancel, and retry during the current page session.
- Do not restore upload tasks after a page reload or browser restart.
- Allow at most two files to upload concurrently. Upload the parts of each file sequentially in the first implementation.

### v0.1.5: Shares

- Share either a file or a folder without copying its contents.
- Use an independent random share URL that does not expose the mount path or provider item identifier.
- Support an optional password, optional expiration time, and an allow-download setting.
- Permit an administrator to list, edit, disable, and delete shares.
- Allow a valid share to expose content from a private mount.
- Do not add user-to-user sharing, access-count limits, upload shares, or per-recipient accounts.

### v0.1.6: Google Drive

- Add multiple Google accounts as independently named and configured mounts.
- Support My Drive listing, download, upload, folder creation, rename, move, and trash.
- Use resumable uploads through the common upload-session API.
- Export Google Docs, Sheets, and Slides as PDF or an appropriate Microsoft Office format.
- Do not support Shared Drives, Shared with me, shortcut expansion, or cross-mount moves in this release.

## Goals

- Remove the current single-request limitation for large OneDrive and S3 uploads.
- Add a secure sharing workflow that works consistently across every mounted provider.
- Add Google Drive without provider-specific UI or duplicate file-management routes.
- Preserve Cloudflare-native Worker routing, D1 persistence, encrypted credentials, and the current React UI architecture.
- Keep each small release independently testable, deployable, reversible, and documented.

## Non-Goals

- Persistent upload recovery after a page refresh.
- Direct browser access to provider credentials, OneDrive upload URLs, or S3 multipart identifiers.
- Durable Objects, Queues, Workflows, a service framework, or a general background-task system.
- Cross-mount copy or move.
- Google Shared Drives, shared-with-me collections, or shortcut traversal.
- Multi-user accounts, share recipients, upload-enabled shares, or access quotas.
- A rewrite of the existing driver registry, virtual file system, authentication, or frontend design system.

## Selected Architecture

Use capability-oriented incremental extension. The upload-session contract is added to the storage-driver layer in `v0.1.4`. Shares resolve targets through the existing mount and provider identity model in `v0.1.5`. Google Drive implements the same driver and upload contracts in `v0.1.6`. Provider-specific behavior remains behind drivers, while routes and UI consume common types.

Cloudflare Worker remains the trust boundary. Browsers send parts through authenticated ilist endpoints. The Worker validates session ownership and forwards each stream without buffering the whole part. Provider credentials and opaque upstream session identifiers remain server-side.

## v0.1.4 Resumable Upload Design

### Driver Contract

Extend the storage driver with a common upload-session contract while retaining `upload` for the small-file path:

```ts
interface CreateUploadSessionInput {
  parentId: string;
  name: string;
  size: number;
  contentType: string | null;
  partSize: number;
}

interface UploadPartResult {
  partNumber: number;
  etag: string | null;
  uploadedBytes: number;
}

interface ProviderUploadSession {
  providerSessionId: string;
  expiresAt: string;
}

interface MultipartUploadDriver {
  createUploadSession(input: CreateUploadSessionInput): Promise<ProviderUploadSession>;
  uploadPart(providerSessionId: string, partNumber: number, body: ReadableStream, size: number): Promise<UploadPartResult>;
  completeUpload(providerSessionId: string, parts: UploadPartResult[]): Promise<StorageItem>;
  abortUpload(providerSessionId: string): Promise<void>;
}
```

The registry exposes multipart support as a driver capability. A route must reject a large upload when the selected driver does not advertise it, rather than silently falling back to a request that exceeds platform limits.

### D1 State

Add an `upload_sessions` table containing:

- ilist session ID and administrator ownership.
- Mount ID, parent provider item ID, file name, size, and content type.
- Provider type and encrypted or protected opaque provider session state.
- Part size, serialized completed-part metadata, status, expiration, creation time, and update time.

Provider session data is never returned to the browser. Records expire and are cleaned lazily when upload APIs are used. Cancellation attempts the upstream abort first and then marks the local session aborted. A failed upstream abort remains safe to retry until provider expiration.

### Worker API

Add administrator-only endpoints under `/api/admin/uploads`:

- `POST /api/admin/uploads/sessions` creates a small or multipart upload session.
- `PUT /api/admin/uploads/sessions/:id/parts/:partNumber` streams and records one part.
- `POST /api/admin/uploads/sessions/:id/complete` verifies all expected parts and finalizes the object.
- `DELETE /api/admin/uploads/sessions/:id` aborts the upload.
- `GET /api/admin/uploads/sessions/:id` returns only safe progress state for current-page reconciliation.

Every request verifies administrator authentication, session ownership, mount availability, target parent, part number, expected byte range, `Content-Length`, total size, and expiration. A repeated part request returns the recorded part when the submitted part number and size match. Completion is idempotent after the provider returns the final item.

### Provider Behavior

OneDrive creates a Graph upload session and sends parts sequentially with correct `Content-Range` values. The final Graph response maps to `StorageItem`. Cancellation deletes the upload session when Graph permits it.

S3 creates a multipart upload, uploads numbered parts, stores returned ETags, completes with the ordered part list, and aborts incomplete uploads. S3-compatible providers that lack a required multipart behavior return a normalized provider-capability error.

### Frontend Behavior

The upload queue gains `paused`, `uploading`, `completing`, `completed`, `failed`, and `cancelled` states. It calculates parts locally, sends one part at a time, and keeps the source `File` object only in memory. Pause takes effect after the active request is aborted or completes; resume retries the unfinished part. Failed parts expose retry without restarting completed parts.

The UI shows total progress, uploaded bytes, current part, pause or resume, cancel, retry, and completion. Closing or reloading the page discards the queue by design; explanatory copy is shown only when a user attempts to leave with active uploads.

## v0.1.5 Sharing Design

### Share Model

Add a `shares` table with:

- Stable internal ID and SHA-256 token hash.
- Mount ID, provider item ID, target kind, and display name snapshot.
- Optional password hash and optional expiration timestamp.
- `allow_download`, `enabled`, creation time, and update time.

The raw token is shown only when a share is created. Updating share policy does not rotate the token. Deleting a share removes access immediately but never deletes provider content.

### Authentication and Access

A share password uses the same password-hashing mechanism and security floor as the administrator password. Successful verification issues a short-lived HttpOnly, Secure, SameSite=Lax cookie scoped to the specific share route. The cookie contains no provider credentials and is signed with `SESSION_SECRET`.

Every list, preview, and download request revalidates the share record, enabled state, expiration, target availability, and password session. Download routes additionally enforce `allow_download`; hiding the download button is not treated as authorization.

### Routes and UI

Administrator APIs create, list, update, disable, and delete shares. Entry action menus add a Share action when the target can be resolved to a stable mount and provider item identity. A management page lists target, policy, status, expiration, creation time, copy-link action, edit, disable, and delete.

Public routes use `/s/:token`. File shares open the existing preview experience with only allowed actions. Folder shares reuse list and grid collection components, breadcrumbs rooted at the share, and restricted entry actions. Share pages have dedicated password, expired, disabled, missing-target, and provider-unavailable states.

Private responses use `private, no-store`. Public share responses are not CDN-cacheable in the first release because policy can change immediately.

## v0.1.6 Google Drive Design

### OAuth and Credentials

Add Google OAuth start and callback routes using authorization code flow with PKCE and one-time D1 OAuth state. Request offline access and the minimum Drive scope that supports full My Drive management. Store access and refresh tokens encrypted through the existing credential service.

Each Google mount has independent credentials, display name, mount path, visibility, enabled state, and optional root folder ID. Token refresh uses the existing D1 refresh lease so concurrent requests do not rotate or overwrite credentials independently.

### Driver Behavior

Represent folders and files by stable Google item IDs. Directory listing uses parent queries, excludes trashed items, requests only required fields, and preserves opaque page tokens as cursors. The virtual root resolver and frontend never expose Google item IDs in paths.

Ordinary files stream through the Worker with Range headers and safe response headers preserved. Workspace-native files expose explicit export choices: PDF plus DOCX for Docs, XLSX for Sheets, and PPTX for Slides. Unsupported native types return a normalized export error.

File mutation maps to Drive API create, update, parent change, and trash operations. Delete moves an item to trash. Uploads use the common `v0.1.4` session API, with provider-specific resumable session state retained only by the Worker.

### Mount UI

The existing storage dialog adds Google Drive as a provider. Connect and reconnect use the same administrator OAuth workflow as OneDrive. The storage table shows account connection status without exposing email or token details to public users. Multiple Google mounts may use different accounts or different root folder IDs.

## Error Handling and Recovery

- Normalize provider authorization, rate-limit, quota, conflict, missing-item, invalid-session, and transient upstream failures into stable ilist error codes.
- Include retry timing for upstream `429` or equivalent responses when available.
- Keep failures scoped to one upload session, share, or mount.
- Preserve completed upload parts when a transient completion request fails.
- Reject completion when expected parts are missing, duplicated, out of range, or have inconsistent sizes.
- Treat a removed share target, disconnected mount, expired credential, and disabled share as distinct public states without leaking provider details.
- Reject OAuth callbacks when state is expired, consumed, bound to another provider or mount, or uses an unexpected origin.
- Never include upstream response bodies, tokens, upload URLs, S3 upload IDs, or signed provider links in public errors or logs.

## Security Constraints

- Bind every upload session to the creating administrator session, mount, target parent, file name, and declared size.
- Validate part number, byte count, total size, and expiration before forwarding a stream.
- Store only share-token hashes, never raw share tokens.
- Reauthorize every shared download server-side.
- Use `private, no-store` for private mount, password-protected share, and authenticated upload responses.
- Keep `CREDENTIAL_MASTER_KEY` stable and use the existing encrypted credential storage for Google tokens and protected provider session state.
- Do not expose OneDrive upload URLs, Google resumable session URLs, S3 credentials, or multipart upload IDs to browser JavaScript.

## Testing and Verification

### v0.1.4

- Driver contract tests for OneDrive sessions and S3 multipart create, upload, complete, abort, and provider failures.
- Worker tests for authorization, ownership, part validation, idempotent retry, expiration, completion, cancellation, and lazy cleanup.
- UI tests for threshold selection, progress, pause, resume, cancel, retry, concurrent-file limit, and completion refresh.
- Integration cases for empty files, files immediately below and at `10 MiB`, non-final and final part sizes, Chinese names, duplicate names, and expired upstream sessions.

### v0.1.5

- Database and route tests for token hashing, password verification, expiration, enable or disable, deletion, private targets, and download policy.
- UI tests for share creation, policy editing, copy link, password entry, folder navigation, preview, and each unavailable state.
- Security tests proving that raw tokens are not stored, disabled links stop immediately, and download denial cannot be bypassed with a direct route.

### v0.1.6

- OAuth tests for PKCE, state consumption, encrypted token persistence, lease-based refresh, and callback failures.
- Driver tests for pagination, item mapping, Range download, exports, upload sessions, folder creation, rename, move, trash, and normalized upstream errors.
- Multi-mount integration tests proving Google, OneDrive, and S3 mounts remain isolated.
- UI tests for adding, connecting, reconnecting, disabling, and deleting multiple Google mounts.

### Release Gate for Every Version

- Run TypeScript checking, the production build, all Worker tests, and all UI tests through `npm run check`.
- Run Playwright browser flows and visual scenarios at desktop, tablet, and `390px` mobile viewports.
- Verify no control overlap, inaccessible modal focus, untranslated copy, or unexpected layout movement.
- Test the new capability against non-production provider fixtures before production deployment.
- Export the production D1 database before applying the incremental migration.
- Apply the remote migration, deploy, and run production smoke tests without changing existing mount data.
- Update both README files and provider setup documentation, then publish one stable GitHub release.

## Delivery Boundaries

Each version receives its own implementation plan, development branch, migration, verification record, documentation update, deployment, and release. Work on `v0.1.5` does not begin until `v0.1.4` is deployed and accepted; work on `v0.1.6` does not begin until `v0.1.5` is deployed and accepted.

The first implementation plan covers only `v0.1.4`. The sharing and Google Drive plans are written when their preceding release is complete, so they can use the final interfaces rather than assumptions.

## Acceptance Criteria

- `v0.1.4` uploads files at or above `10 MiB` through provider sessions with in-page pause, resume, retry, cancel, and accurate progress for OneDrive and S3-compatible mounts.
- `v0.1.5` creates revocable file and folder shares with optional password, optional expiration, and enforced download policy across all supported mounts.
- `v0.1.6` supports multiple My Drive mounts with complete first-release file management, resumable upload, ordinary-file download, and Workspace export.
- Existing native R2, S3, and OneDrive mounts continue to browse and mutate files without migration-related data loss.
- Provider secrets and opaque upload state never reach public APIs, browser state, logs, or D1 in plaintext where encryption is required.
- Every release passes its automated, browser, visual, migration, and production smoke-test gates before publication.
