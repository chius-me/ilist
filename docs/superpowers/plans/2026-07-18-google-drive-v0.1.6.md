# Google Drive v0.1.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multiple independently authorized Google My Drive mounts with browsing, file management, streaming downloads, Workspace exports, and resumable uploads.

**Architecture:** Implement Google Drive behind the existing provider-neutral `StorageDriver` and common upload-session service. OAuth credentials remain encrypted in D1, refreshes use the existing per-mount lease, and the React UI only learns the provider and export options rather than Google item internals.

**Tech Stack:** Cloudflare native Workers, TypeScript, D1, Web Crypto, Google OAuth 2.0 and Drive API v3, React/Vite, Vitest, Playwright.

## Global Constraints

- Release version is `v0.1.6`; this release contains Google Drive only.
- Support multiple independent My Drive mounts with custom names and mount paths.
- Support My Drive only; exclude Shared Drives, Shared with me, and shortcut traversal.
- Use Authorization Code flow with PKCE, one-time D1 state, offline access, and encrypted credentials.
- Stream ordinary downloads through the Worker and forward valid `Range` requests; never buffer complete files.
- Expose explicit PDF/DOCX, PDF/XLSX, and PDF/PPTX export choices for Docs, Sheets, and Slides respectively.
- Use the common upload-session API; provider resumable-session URLs never leave the Worker.
- Keep R2, S3, OneDrive, controlled shares, and legacy URLs behaviorally unchanged.
- Do not add Hono, an ORM, Google client libraries, or background-task infrastructure.

---

### Task 1: Provider-Neutral Export Contract

**Files:**
- Modify: `src/worker/types.ts`
- Modify: `src/worker/drivers/types.ts`
- Modify: `src/worker/external-entries.ts`
- Modify: `src/worker/share-targets.ts`
- Modify: `src/ui/types/entries.ts`
- Modify: `src/ui/api/entries.ts`
- Modify: `src/ui/api/public-shares.ts`
- Test: `tests/worker/external-identity.test.ts`
- Test: `tests/worker/share-targets.test.ts`

**Interfaces:**
- Produces: `FileExportOption { format, label, extension, contentType }` and optional `exportOptions` on `StorageItem` and API `Entry`.
- Produces: `fileUrl(entry, download, exportFormat?)` and `publicShareFileUrl(token, entry, download, exportFormat?)`.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(apiEntry.exportOptions).toEqual([
  { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' },
]);
expect(fileUrl(entry, true, 'pdf')).toContain('export=pdf');
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/external-identity.test.ts tests/worker/share-targets.test.ts`

Expected: FAIL because `exportOptions` is not mapped and URL helpers do not accept a format.

- [ ] **Step 3: Add the minimal provider-neutral types and mappings**

```ts
export interface FileExportOption {
  format: string;
  label: string;
  extension: string;
  contentType: string;
}

export interface StorageItem {
  // existing fields
  exportOptions?: FileExportOption[];
}
```

Map a copied array into external entries and share entries. Append `export=<encoded format>` only when supplied; preserve existing URLs otherwise.

- [ ] **Step 4: Verify GREEN and regression safety**

Run: `npm run test:worker`

Expected: all worker tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/types.ts src/worker/drivers/types.ts src/worker/external-entries.ts src/worker/share-targets.ts src/ui/types/entries.ts src/ui/api/entries.ts src/ui/api/public-shares.ts tests/worker/external-identity.test.ts tests/worker/share-targets.test.ts
git commit -m "feat: add file export contract"
```

### Task 2: Google OAuth and Token Lifecycle

**Files:**
- Create: `src/worker/drivers/google/oauth.ts`
- Create: `src/worker/drivers/google/tokens.ts`
- Modify: `src/worker/oauth-routes.ts`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/env.d.ts`
- Modify: `wrangler.jsonc`
- Test: `tests/worker/google-oauth.test.ts`
- Test: `tests/worker/google-tokens.test.ts`
- Modify: `tests/worker/setup.ts`

**Interfaces:**
- Produces: `GOOGLE_DRIVE_SCOPES`, `googleDriveCallbackUrl(env)`, `createGoogleAuthorization(env, mountId)`, `consumeGoogleOAuthState(env, state)`, and `requestGoogleTokens(env, parameters, fetcher?)`.
- Produces: `getGoogleAccessToken(env, mount, credentials, fetcher?)` using `oauth_refresh_leases` and `putCredentials`.
- Requires secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; reuses `PUBLIC_ORIGIN` and `CREDENTIAL_MASTER_KEY`.

- [ ] **Step 1: Write failing OAuth and refresh tests**

```ts
expect(url.origin).toBe('https://accounts.google.com');
expect(url.searchParams.get('access_type')).toBe('offline');
expect(url.searchParams.get('code_challenge_method')).toBe('S256');
await expect(consumeGoogleOAuthState(env, state)).resolves.toMatchObject({ mountId });
await expect(consumeGoogleOAuthState(env, state)).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
expect(refreshRequests).toHaveLength(1);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/google-oauth.test.ts tests/worker/google-tokens.test.ts`

Expected: FAIL because Google OAuth modules and environment bindings do not exist.

- [ ] **Step 3: Implement OAuth and encrypted token exchange**

Use `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`, exact callback `${PUBLIC_ORIGIN}/api/admin/oauth/google/callback`, scope `https://www.googleapis.com/auth/drive`, `access_type=offline`, `prompt=consent`, and PKCE S256. Store access token, refresh token, expiry, token type, and scope through `putCredentials`; never return token endpoint bodies to clients.

- [ ] **Step 4: Implement lease-coordinated refresh**

```ts
export async function getGoogleAccessToken(
  env: Env,
  mount: Mount,
  credentials: StorageCredentials | null,
  fetcher: typeof fetch = fetch,
): Promise<string>
```

Return a non-expiring token immediately, acquire the existing per-mount refresh lease when near expiry, re-read credentials after lease contention, rotate the refresh token only when Google returns a replacement, and normalize invalid credentials as `GOOGLE_AUTH_REQUIRED`.

- [ ] **Step 5: Add admin start/callback routes and verify GREEN**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/google-oauth.test.ts tests/worker/google-tokens.test.ts`

Expected: both files PASS, including expired/replayed state, denied consent, missing refresh token, one-refresh concurrency, and sanitized errors.

- [ ] **Step 6: Commit**

```bash
git add src/worker/drivers/google src/worker/oauth-routes.ts src/worker/types.ts src/worker/env.d.ts wrangler.jsonc tests/worker/google-oauth.test.ts tests/worker/google-tokens.test.ts tests/worker/setup.ts
git commit -m "feat: add Google Drive OAuth"
```

### Task 3: Google Drive Client, Mapping, Downloads, and Exports

**Files:**
- Create: `src/worker/drivers/google/client.ts`
- Create: `src/worker/drivers/google/items.ts`
- Test: `tests/worker/google-client.test.ts`

**Interfaces:**
- Produces: `GoogleDriveClient` methods `list`, `stat`, `download`, `exportFile`, `createFolder`, `upload`, `rename`, `move`, `trash`, and `createResumableUpload`.
- Produces: `mapGoogleFile(file): StorageItem`, `googleExportOptions(mimeType)`, and normalized `HttpError` codes.

- [ ] **Step 1: Write failing mapping, pagination, download, and error tests**

```ts
expect(result.nextCursor).toBe('next-page');
expect(result.items[0]).toMatchObject({ id: 'file-1', parentId: 'root', kind: 'file' });
expect(request.headers.get('Range')).toBe('bytes=10-20');
expect(doc.exportOptions?.map((option) => option.format)).toEqual(['pdf', 'docx']);
expect(error).toMatchObject({ status: 429, code: 'GOOGLE_RATE_LIMITED' });
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/google-client.test.ts`

Expected: FAIL because client and mapper modules do not exist.

- [ ] **Step 3: Implement file mapping and export matrix**

Map Google folder MIME type to `folder`; map Docs to PDF/DOCX, Sheets to PDF/XLSX, and Slides to PDF/PPTX. Preserve stable item IDs and first parent ID; do not traverse shortcuts.

- [ ] **Step 4: Implement paginated API calls and streaming transfers**

List with `q='<escaped parent>' in parents and trashed=false`, `spaces=drive`, `pageToken`, and a restricted `fields` projection. Ordinary downloads call `files/{id}?alt=media`, forward only valid single byte ranges, and return a streaming `Response`. Exports call `files/{id}/export?mimeType=...` after validating the requested format against the mapped options.

- [ ] **Step 5: Normalize upstream failures**

Map 401/403 auth failures, 404 missing items, 409 conflicts, 429 rate limits, quota reasons, invalid upload sessions, and transient 5xx responses to stable public codes without provider response bodies.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/google-client.test.ts`

Expected: all Google client tests PASS.

```bash
git add src/worker/drivers/google/client.ts src/worker/drivers/google/items.ts tests/worker/google-client.test.ts
git commit -m "feat: add Google Drive API client"
```

### Task 4: Google Storage Driver and Multi-Mount Isolation

**Files:**
- Create: `src/worker/drivers/google/driver.ts`
- Modify: `src/worker/drivers/registry.ts`
- Modify: `src/worker/types.ts`
- Test: `tests/worker/google-driver.test.ts`
- Modify: `tests/worker/multi-mount-integration.test.ts`

**Interfaces:**
- Produces: `GoogleDrive implements StorageDriver` and `createGoogleDrive(env, mount, credentials)` registry factory.
- Consumes: `GoogleDriveClient`, `getGoogleAccessToken`, mount `rootItemId`, and provider-neutral export options.

- [ ] **Step 1: Write failing driver behavior tests**

```ts
expect(driver.rootId).toBe('configured-root');
await expect(driver.list('outside-root')).rejects.toMatchObject({ code: 'ITEM_OUTSIDE_MOUNT' });
await driver.rename('item', 'renamed.txt');
await driver.move('item', 'destination');
await driver.remove('item');
```

Cover root fallback to `root`, capabilities, list/stat, requested export selection, folder creation, small upload, rename, move, trash, disabled mount handling, and two mounts using distinct credentials/root IDs.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/google-driver.test.ts tests/worker/multi-mount-integration.test.ts`

Expected: FAIL because the Google driver is absent from the registry.

- [ ] **Step 3: Implement scope-safe driver delegation**

Mirror the OneDrive driver's ancestor validation but use stable Google parent IDs. `remove` must set `trashed=true`, not permanently delete. `getDownload` must require `export` for Workspace-native files and reject unsupported formats with `GOOGLE_EXPORT_UNSUPPORTED`.

- [ ] **Step 4: Register `google` and verify GREEN**

Run: `npm run test:worker`

Expected: all worker tests PASS and existing drivers remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/worker/drivers/google/driver.ts src/worker/drivers/registry.ts src/worker/types.ts tests/worker/google-driver.test.ts tests/worker/multi-mount-integration.test.ts
git commit -m "feat: add Google Drive storage driver"
```

### Task 5: Google Resumable Upload Adapter

**Files:**
- Modify: `src/worker/drivers/google/client.ts`
- Modify: `src/worker/drivers/google/driver.ts`
- Test: `tests/worker/google-driver.test.ts`
- Modify: `tests/worker/upload-service.test.ts`
- Modify: `tests/worker/upload-routes.test.ts`

**Interfaces:**
- Produces: Google `ResumableUploadAdapter` state `{ sessionUrl, nextOffset }`, with session URL retained only in encrypted server-side upload state.
- Consumes: common `create/uploadPart/complete/abort` contract and 10 MiB common part size, which is a valid multiple of Google's 256 KiB requirement.

- [ ] **Step 1: Write failing resumable tests**

```ts
expect(created.state).toMatchObject({ nextOffset: 0 });
expect(publicSessionJson).not.toContain('googleusercontent.com');
expect(chunkRequest.headers.get('Content-Range')).toBe('bytes 0-10485759/12582912');
expect(intermediate.part.completedItem).toBeUndefined();
expect(final.part.completedItem?.id).toBe('uploaded-file');
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/google-driver.test.ts tests/worker/upload-service.test.ts tests/worker/upload-routes.test.ts`

Expected: FAIL because Google has no resumable adapter.

- [ ] **Step 3: Implement session creation and ordered chunk upload**

Create a resumable upload with metadata `{ name, parents: [parentId] }`, capture the `Location` header, send ordered `PUT` requests with `Content-Length` and `Content-Range`, parse 308 `Range` progress, accept final 200/201 metadata, and map expired sessions to `UPLOAD_SESSION_EXPIRED`.

- [ ] **Step 4: Implement complete and abort semantics**

`complete` returns the item captured by the final chunk and rejects incomplete state. `abort` makes a best-effort request to the session URL and treats 404/410 as already aborted.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm run test:worker`

Expected: all worker and upload tests PASS.

```bash
git add src/worker/drivers/google/client.ts src/worker/drivers/google/driver.ts tests/worker/google-driver.test.ts tests/worker/upload-service.test.ts tests/worker/upload-routes.test.ts
git commit -m "feat: add Google Drive resumable uploads"
```

### Task 6: Mount Administration and Google Connection UI

**Files:**
- Modify: `src/worker/mount-routes.ts`
- Modify: `src/ui/types/mounts.ts`
- Modify: `src/ui/api/mounts.ts`
- Modify: `src/ui/features/mounts/MountDialog.tsx`
- Modify: `src/ui/features/mounts/MountManager.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `tests/worker/mount-routes.test.ts`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/web-ui.spec.ts`

**Interfaces:**
- Produces: `GoogleMountInput { driverType: 'google'; provider: 'google'; rootItemId?: string; config: {} }`.
- Produces: `googleDriveConnectUrl(id)` and UI actions connect, reconnect, disconnect, disable, edit, and delete.

- [ ] **Step 1: Write failing route and browser tests**

```ts
expect(created).toMatchObject({ driverType: 'google', provider: 'google', connected: false });
await page.getByRole('button', { name: /Google Drive/ }).click();
await expect(page.getByLabel(/Mount name/)).toBeVisible();
await expect(page.getByRole('link', { name: /Connect/ })).toHaveAttribute('href', /oauth\/google\/start/);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/mount-routes.test.ts`

Run: `npx playwright test tests/e2e/web-ui.spec.ts --grep "Google Drive mount"`

Expected: both fail because Google is not an accepted provider.

- [ ] **Step 3: Extend mount validation and connection state**

Accept only empty Google config plus optional non-empty root item ID. Report `connected` from encrypted credentials exactly as OneDrive does. Disconnect deletes only that mount's credentials.

- [ ] **Step 4: Add Google provider to existing mount dialog and manager**

Keep the current compact storage-management layout. Add a Google Drive provider choice, custom name/path, optional root folder ID, connection status, and the same lifecycle actions as OneDrive; do not add a separate settings page.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm run test:worker`

Run: `npx playwright test tests/e2e/web-ui.spec.ts --grep "storage management|Google Drive mount"`

Expected: route and browser tests PASS at desktop, tablet, and mobile projects.

```bash
git add src/worker/mount-routes.ts src/ui/types/mounts.ts src/ui/api/mounts.ts src/ui/features/mounts/MountDialog.tsx src/ui/features/mounts/MountManager.tsx src/ui/i18n/messages.ts tests/worker/mount-routes.test.ts tests/e2e/fixtures.ts tests/e2e/web-ui.spec.ts
git commit -m "feat: add Google Drive mount management"
```

### Task 7: Workspace Export Interaction and Preview

**Files:**
- Modify: `src/ui/features/explorer/EntryActionMenu.tsx`
- Modify: `src/ui/features/explorer/EntryRow.tsx`
- Modify: `src/ui/features/explorer/MobileActionSheet.tsx`
- Modify: `src/ui/features/preview/PreviewOverlay.tsx`
- Modify: `src/ui/app/ExplorerPage.tsx`
- Modify: `src/ui/app/SharePage.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/web-ui.spec.ts`
- Modify: `tests/e2e/shares.spec.ts`

**Interfaces:**
- Consumes: `Entry.exportOptions` and URL helpers' optional `exportFormat`.
- Produces: explicit export actions and PDF-first preview for Google Workspace files in normal and controlled-share views.

- [ ] **Step 1: Write failing export interaction tests**

```ts
await page.getByText('Quarterly report').click({ button: 'right' });
await expect(page.getByRole('menuitem', { name: 'Export PDF' })).toBeVisible();
await expect(page.getByRole('menuitem', { name: 'Export DOCX' })).toHaveAttribute('href', /export=docx/);
```

Also assert mobile action-sheet choices, PDF preview URL, and controlled-share export URLs.

- [ ] **Step 2: Verify RED**

Run: `npx playwright test tests/e2e/web-ui.spec.ts tests/e2e/shares.spec.ts --grep "Workspace export"`

Expected: FAIL because export choices are not rendered.

- [ ] **Step 3: Render explicit format actions**

For files with `exportOptions`, replace the generic download action with one action per format. Use the first PDF option for preview; retain the fallback details view when no previewable export exists. Keep ordinary-file behavior unchanged.

- [ ] **Step 4: Verify responsive UI and GREEN**

Run: `npx playwright test tests/e2e/web-ui.spec.ts tests/e2e/shares.spec.ts --grep "Workspace export"`

Expected: PASS on desktop, tablet, and mobile with no clipped or overlapping controls.

- [ ] **Step 5: Commit**

```bash
git add src/ui/features/explorer/EntryActionMenu.tsx src/ui/features/explorer/EntryRow.tsx src/ui/features/explorer/MobileActionSheet.tsx src/ui/features/preview/PreviewOverlay.tsx src/ui/app/ExplorerPage.tsx src/ui/app/SharePage.tsx src/ui/i18n/messages.ts tests/e2e/fixtures.ts tests/e2e/web-ui.spec.ts tests/e2e/shares.spec.ts
git commit -m "feat: add Workspace export actions"
```

### Task 8: Release Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/releases/v0.1.6.md`

**Interfaces:**
- Documents: Google Cloud OAuth setup, exact redirect URI, required secrets, supported scope, My Drive limitations, mount lifecycle, export behavior, and upload behavior.

- [ ] **Step 1: Update version and both READMEs**

Set package version to `0.1.6`. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` setup without example secrets, document redirect URI `${PUBLIC_ORIGIN}/api/admin/oauth/google/callback`, and mark Google Drive support complete while retaining Shared Drive/shortcut limitations.

- [ ] **Step 2: Add release notes**

```markdown
# ilist v0.1.6

- Multiple independently authorized Google My Drive mounts
- Streaming ordinary downloads with Range support
- Docs, Sheets, and Slides exports
- Small and resumable uploads plus folder, rename, move, and trash operations
```

- [ ] **Step 3: Run complete verification**

Run: `npm run check`

Run: `npm run test:e2e`

Run: `npm run test:visual`

Expected: TypeScript, build, all worker/UI tests, all E2E tests, and all visual snapshots PASS.

- [ ] **Step 4: Review security and diff**

Run: `rg -n "GOOGLE_CLIENT_SECRET|refresh_token|sessionUrl" src tests README.md README.zh-CN.md wrangler.jsonc`

Expected: no literal secret, public token response, public resumable URL, or unsanitized logging.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-CN.md package.json package-lock.json docs/releases/v0.1.6.md
git commit -m "docs: prepare v0.1.6 release"
```

### Task 9: Production Deployment and v0.1.6 Release

**Files:**
- No tracked source files unless deployment verification finds a release-blocking defect, which must return to the relevant TDD task.

**Interfaces:**
- Consumes: Cloudflare Worker, D1, and user-provided Google OAuth application credentials.
- Produces: deployed Worker version, Git tag `v0.1.6`, and GitHub release.

- [ ] **Step 1: Back up production D1**

Run: `npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-v0.1.6.sql`

Expected: successful export; record `shasum -a 256 /tmp/ilist-db-before-v0.1.6.sql` in release notes outside Git.

- [ ] **Step 2: Configure production secrets**

Run: `npx wrangler secret put GOOGLE_CLIENT_ID`

Run: `npx wrangler secret put GOOGLE_CLIENT_SECRET`

Expected: both secrets uploaded without their values appearing in command output or Git.

- [ ] **Step 3: Deploy and run production smoke tests**

Run: `npm run deploy`

Expected: Wrangler reports the production URL and Worker version ID. Verify login, Google connect callback, two distinct mounts, list/stat, Range download, each Workspace export family, small upload, resumable upload, create folder, rename, move, trash, disable/re-enable, disconnect/reconnect, and existing R2/OneDrive/share flows. Clean all smoke-test data.

- [ ] **Step 4: Publish source and release**

```bash
git push origin main
git tag -a v0.1.6 -m "ilist v0.1.6"
git push origin v0.1.6
gh release create v0.1.6 --title "ilist v0.1.6" --notes-file docs/releases/v0.1.6.md
```

Expected: GitHub main, tag, and release all point to the verified commit.
