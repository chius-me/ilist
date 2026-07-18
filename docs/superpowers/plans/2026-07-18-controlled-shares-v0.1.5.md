# ilist v0.1.5 Controlled Shares Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add revocable file and folder shares with optional password, optional expiration, and server-enforced download policy for native R2, S3-compatible, and OneDrive mounts.

**Architecture:** Store only a SHA-256 share-token hash in D1 and resolve each target through the existing mount and driver boundaries. Public child identifiers are AES-GCM sealed, share-scoped handles so mount IDs and provider item IDs never reach URLs or browser state. Keep administrator CRUD under `/api/admin/shares`; serve public metadata, authentication, folder navigation, preview, and downloads under `/s/:token/*`, with every request revalidating the current share policy.

**Tech Stack:** Cloudflare native Workers, TypeScript, D1, Web Crypto, React 19, Vite, Vitest with `@cloudflare/vitest-pool-workers`, Playwright.

## Global Constraints

- Release version is `v0.1.5`; do not add Google Drive or change storage-driver behavior.
- File and folder shares support optional password, optional expiration, `allowDownload`, enable, edit, and delete.
- Do not add upload shares, recipient accounts, access quotas, access counters, or user-to-user sharing.
- Store only SHA-256 hashes of raw share tokens; return the raw token exactly once from create.
- Public handles must not disclose mount IDs, provider item IDs, credentials, or provider URLs.
- Password cookies are `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, short-lived, and scoped to `/s/:token`.
- Every public metadata, list, preview, and download request revalidates enabled state, expiration, target availability, and password authorization.
- `allowDownload=false` blocks direct download requests in the Worker; hiding UI controls is not authorization.
- All share responses use `Cache-Control: private, no-store` so policy changes take effect immediately.
- Existing native R2, S3, and OneDrive browsing, upload, mutation, and download behavior must remain compatible.

---

### Task 1: Share Schema, Domain Store, and Password Hashing

**Files:**
- Create: `migrations/0014_shares.sql`
- Create: `src/worker/share-store.ts`
- Modify: `src/worker/auth.ts`
- Modify: `src/worker/types.ts`
- Modify: `tests/worker/setup.ts`
- Create: `tests/worker/share-store.test.ts`
- Modify: `tests/worker/router.test.ts`

**Interfaces:**
- Produces: `Share`, `ShareRow`, `CreateShareRecordInput`, `UpdateShareRecordInput`.
- Produces: `createShareRecord`, `getShareById`, `getShareByTokenHash`, `listShares`, `updateShareRecord`, `deleteShareRecord`.
- Produces: exported `sha256Hex(value)`, `hashPassword(password)`, and existing `verifyPassword(password, storedHash)`.

- [ ] **Step 1: Add failing migration and store tests**

Cover migration constraints, raw-token absence, create/list/update/delete, optional policy fields, mount cascade deletion, and PBKDF2 round-trip:

```ts
const created = await createShareRecord(env.DB, {
  tokenHash: await sha256Hex('raw-secret'),
  mountId: 'native-r2', providerItemId: 'private-file',
  targetKind: 'file', name: 'private.txt', passwordHash: null,
  expiresAt: null, allowDownload: false, enabled: true,
});
expect(JSON.stringify(created)).not.toContain('raw-secret');
expect(await getShareByTokenHash(env.DB, await sha256Hex('raw-secret'))).toMatchObject({ id: created.id });
expect(await verifyPassword('share-password', await hashPassword('share-password'))).toBe(true);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run test:worker -- tests/worker/share-store.test.ts`

Expected: FAIL because migration `0014_shares.sql` and share-store exports do not exist.

- [ ] **Step 3: Add the schema and minimal domain implementation**

Create `shares` with `id`, unique `token_hash`, `mount_id`, `provider_item_id`, checked `target_kind`, `name`, nullable `password_hash`, nullable Unix-second `expires_at`, checked integer booleans `allow_download` and `enabled`, plus ISO timestamps. Add indexes for `mount_id` and administrative ordering. Use `ON DELETE CASCADE` from `mounts(id)`.

Implement strict row mapping and patch allowlists. Export `sha256Hex`; add `hashPassword` using PBKDF2-SHA-256, 100000 iterations, 16 random salt bytes, and 32 output bytes so generated hashes meet the existing verification floor.

- [ ] **Step 4: Register the migration in Worker tests and verify GREEN**

Import `0014_shares.sql?raw` in `tests/worker/setup.ts`, append it after upload migrations, and run:

`npm run test:worker -- tests/worker/share-store.test.ts tests/worker/router.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add migrations/0014_shares.sql src/worker/share-store.ts src/worker/auth.ts src/worker/types.ts tests/worker/setup.ts tests/worker/share-store.test.ts tests/worker/router.test.ts
git commit -m "feat: add controlled share records"
```

### Task 2: Share Tokens, Password Sessions, and Opaque Item Handles

**Files:**
- Create: `src/worker/share-crypto.ts`
- Create: `src/worker/share-auth.ts`
- Create: `tests/worker/share-crypto.test.ts`
- Create: `tests/worker/share-auth.test.ts`

**Interfaces:**
- Produces: `createShareToken(): { token: string; tokenHash: Promise<string> }`.
- Produces: `sealShareItem(env, shareId, itemId): Promise<string>` and `openShareItem(env, shareId, handle): Promise<string>`.
- Produces: `createShareAuthorization`, `hasShareAuthorization`, `shareAuthorizationCookie`, `clearShareAuthorizationCookie`.

- [ ] **Step 1: Write failing cryptographic-boundary tests**

Test 32-byte base64url tokens, deterministic token hashing, random AES-GCM handles, share-bound AAD rejection, tamper rejection, cookie signature verification, expiry, token-specific cookie names, HTTPS flags, and cookie paths:

```ts
const handle = await sealShareItem(workerEnv(), 'share-a', 'provider-item-42');
expect(handle).not.toContain('provider-item-42');
await expect(openShareItem(workerEnv(), 'share-b', handle)).rejects.toMatchObject({ code: 'SHARE_ITEM_INVALID' });

const authorization = await createShareAuthorization(workerEnv(), 'share-a', 1_000);
const header = shareAuthorizationCookie(new Request('https://ilist.example/s/token'), 'token', authorization);
expect(header).toContain('Path=/s/token');
expect(header).toContain('HttpOnly');
expect(header).toContain('Secure');
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test:worker -- tests/worker/share-crypto.test.ts tests/worker/share-auth.test.ts`

Expected: FAIL because the cryptographic modules do not exist.

- [ ] **Step 3: Implement sealed handles and signed authorization cookies**

Derive separate AES-GCM and HMAC-SHA-256 keys from `SESSION_SECRET` using SHA-256 domain-separated inputs. Seal only `{ v: 1, itemId }` with a random 12-byte IV and share ID as AAD. Sign compact `{ v: 1, shareId, exp }` authorization payloads and compare signatures without early exit. Reject malformed, expired, wrong-share, and tampered values with stable public errors.

Cookie names use the first 16 hex characters of `sha256Hex(token)` so separate share cookies do not collide. Encode the raw token path segment when generating `Path=/s/:token`.

- [ ] **Step 4: Verify GREEN and run auth regressions**

Run: `npm run test:worker -- tests/worker/share-crypto.test.ts tests/worker/share-auth.test.ts tests/worker/router.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the security boundary**

```bash
git add src/worker/share-crypto.ts src/worker/share-auth.ts tests/worker/share-crypto.test.ts tests/worker/share-auth.test.ts
git commit -m "feat: secure share tokens and item handles"
```

### Task 3: Share Target Resolution and Restricted Directory Model

**Files:**
- Create: `src/worker/share-targets.ts`
- Modify: `src/worker/entries.ts`
- Modify: `src/worker/external-entries.ts`
- Create: `tests/worker/share-targets.test.ts`
- Modify: `tests/worker/multi-mount-integration.test.ts`

**Interfaces:**
- Produces: `resolveShareCreationTarget(env, entryId): Promise<ShareTarget>`.
- Produces: `resolveSharedItem(env, share, opaqueHandle | null): Promise<ResolvedSharedItem>`.
- Produces: `listSharedFolder(env, share, opaqueHandle | null): Promise<ShareDirectoryResponse>`.
- Produces: `downloadSharedFile(env, share, handle, request): Promise<Response>`.
- Consumes: Task 2 `sealShareItem` and `openShareItem`.

- [ ] **Step 1: Write failing native R2 and external-driver tests**

Test root target creation, native child listing by D1 parent ID, S3/OneDrive listing through `StorageDriver.list`, file stat, Range streaming, redirect wrapping, disabled mount, missing target, wrong-kind list, and opaque IDs:

```ts
const directory = await listSharedFolder(workerEnv(), shareFor('native-r2', 'private-folder'), null);
expect(directory.current.name).toBe('Private folder');
expect(directory.items[0].id).not.toContain('private-child');
expect(directory.items[0].capabilities).toMatchObject({ preview: true, download: false, rename: false, delete: false });
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test:worker -- tests/worker/share-targets.test.ts tests/worker/multi-mount-integration.test.ts`

Expected: FAIL because share target resolution is absent.

- [ ] **Step 3: Implement provider-neutral target resolution**

For `native-r2`, treat `providerItemId` as an entry ID, require `ready`, list with `listChildRows`, and stream with `streamEntryObject` without applying normal public visibility. For external mounts, create the driver, use stable provider item IDs internally, list one folder level through all cursor pages, and stream or redirect through `getDownload`.

Return share-only `Entry` values with sealed IDs, no `mountId` or `mountPath`, and capabilities limited to open, preview, and policy-controlled download. Breadcrumbs begin at the share target and contain only sealed handles issued within that share.

- [ ] **Step 4: Verify GREEN and run storage regressions**

Run: `npm run test:worker -- tests/worker/share-targets.test.ts tests/worker/multi-mount-integration.test.ts tests/worker/storage.test.ts tests/worker/onedrive-driver.test.ts tests/worker/s3-driver.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit target resolution**

```bash
git add src/worker/share-targets.ts src/worker/entries.ts src/worker/external-entries.ts tests/worker/share-targets.test.ts tests/worker/multi-mount-integration.test.ts
git commit -m "feat: resolve shared storage targets"
```

### Task 4: Administrator Share CRUD API

**Files:**
- Create: `src/worker/share-admin-routes.ts`
- Modify: `src/worker/router.ts`
- Create: `tests/worker/share-admin-routes.test.ts`

**Interfaces:**
- Adds: `POST /api/admin/shares` with `{ entryId, password?, expiresAt?, allowDownload, enabled? }`.
- Adds: `GET /api/admin/shares`.
- Adds: `PATCH /api/admin/shares/:id` with policy fields only.
- Adds: `DELETE /api/admin/shares/:id`.
- Create returns `{ share, url }`; list and patch never return token hashes, password hashes, provider item IDs, or raw tokens.

- [ ] **Step 1: Write failing route tests**

Cover authentication, same-origin mutation checks, native/private and external targets, minimum eight-character optional passwords, future ISO expiration, token URL returned once, redacted list output, policy patch without token rotation, disable, delete, malformed IDs, and missing targets.

```ts
const response = await SELF.fetch(`${origin}/api/admin/shares`, {
  method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ entryId: privateFileId, password: 'share-pass', allowDownload: false }),
});
const payload = await response.json() as { data: { url: string; share: Record<string, unknown> } };
expect(payload.data.url).toMatch(/^https:\/\/ilist\.example\/s\/[A-Za-z0-9_-]+$/);
expect(JSON.stringify(payload.data.share)).not.toMatch(/tokenHash|passwordHash|providerItemId/);
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm run test:worker -- tests/worker/share-admin-routes.test.ts`

Expected: FAIL with 404 responses because share admin routes are not registered.

- [ ] **Step 3: Implement strict CRUD request validation and redaction**

Generate the token only after target validation. Build the absolute URL from `PUBLIC_ORIGIN`, reject origins that are not HTTPS outside local development, hash optional passwords, and convert ISO expiration to Unix seconds. PATCH accepts only `password`, `clearPassword`, `expiresAt`, `allowDownload`, and `enabled`; reject unknown or contradictory fields.

Register `handleShareAdminRoutes` after admin authentication and before legacy object routes.

- [ ] **Step 4: Verify GREEN and route regressions**

Run: `npm run test:worker -- tests/worker/share-admin-routes.test.ts tests/worker/router.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit administrator routes**

```bash
git add src/worker/share-admin-routes.ts src/worker/router.ts tests/worker/share-admin-routes.test.ts
git commit -m "feat: add share administration api"
```

### Task 5: Public Share Authentication, Browsing, and Download Routes

**Files:**
- Create: `src/worker/share-public-routes.ts`
- Modify: `src/worker/router.ts`
- Modify: `wrangler.jsonc`
- Create: `tests/worker/share-public-routes.test.ts`

**Interfaces:**
- Adds: `GET /s/:token/api` for policy-safe metadata and a root file or folder entry.
- Adds: `POST /s/:token/auth` with `{ password }`.
- Adds: `GET /s/:token/api/list?parent=` for a shared folder.
- Adds: `GET /s/:token/api/entries/:handle` for preview metadata.
- Adds: `GET|HEAD /s/:token/file/:handle/:name` with optional `?download=1`.
- Adds `/s/*` to Workers Assets `run_worker_first`; non-API `/s/:token` requests still fall through to `ASSETS.fetch`.

- [ ] **Step 1: Write failing public policy tests**

Cover unknown token, password required, wrong password, authorization cookie, expiration, disabled share, deleted share, missing target, disconnected mount, folder traversal, Range preview, HEAD, download denial with `?download=1`, inline preview when downloads are denied, and `private, no-store` on every response.

```ts
const denied = await SELF.fetch(`${origin}/s/${token}/file/${handle}/private.txt?download=1`, { headers: { cookie: shareCookie } });
expect(denied.status).toBe(403);
expect((await denied.json() as { error: { code: string } }).error.code).toBe('SHARE_DOWNLOAD_DISABLED');
expect(denied.headers.get('cache-control')).toBe('private, no-store');
```

- [ ] **Step 2: Run public route tests and verify RED**

Run: `npm run test:worker -- tests/worker/share-public-routes.test.ts`

Expected: FAIL because `/s/*` is still served only as SPA assets.

- [ ] **Step 3: Implement revalidated public routing**

Hash the path token and fetch the share on every request. Return distinct stable errors: `SHARE_NOT_FOUND`, `SHARE_DISABLED`, `SHARE_EXPIRED`, `SHARE_PASSWORD_REQUIRED`, `SHARE_PASSWORD_INVALID`, `SHARE_TARGET_MISSING`, and `SHARE_PROVIDER_UNAVAILABLE`. Do not distinguish unknown token hashes by timing-sensitive string comparison.

Permit inline preview whenever the shared file is previewable; enforce `allowDownload` only when `download=1` or when an explicit attachment response is requested. Override upstream cache headers with `private, no-store` and preserve safe Range response headers.

- [ ] **Step 4: Verify GREEN and full Worker suite**

Run: `npm run test:worker`

Expected: all Worker tests PASS.

- [ ] **Step 5: Commit public routes**

```bash
git add src/worker/share-public-routes.ts src/worker/router.ts wrangler.jsonc tests/worker/share-public-routes.test.ts
git commit -m "feat: serve protected file shares"
```

### Task 6: Share Creation Dialog and Administrator Management Page

**Files:**
- Create: `src/ui/types/shares.ts`
- Create: `src/ui/api/shares.ts`
- Create: `src/ui/features/shares/ShareDialog.tsx`
- Create: `src/ui/features/shares/ShareManager.tsx`
- Modify: `src/ui/features/explorer/EntryActionMenu.tsx`
- Modify: `src/ui/app/ExplorerPage.tsx`
- Modify: `src/ui/app/AdminLayout.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `src/ui/i18n/apiErrors.ts`
- Modify: `src/ui/styles/admin.css`
- Modify: `src/ui/styles/overlays.css`
- Create: `tests/ui/shares.test.tsx`
- Modify: `tests/ui/admin-layout.test.tsx`
- Modify: `tests/ui/explorer.test.tsx`

**Interfaces:**
- Produces typed `createShare`, `listShares`, `updateShare`, and `deleteShare` API functions.
- Adds `share` to `EntryActionId` for administrators.
- Adds `shares` to `AdminSection` and `/admin/shares` navigation.

- [ ] **Step 1: Write failing UI interaction tests**

Test action visibility only for administrators, create form defaults, password and expiration validation, one-time link copy, edit without token rotation, clear password, enable or disable, delete confirmation, loading, empty, and API error states. Verify secrets and provider IDs never render.

```tsx
await user.click(screen.getByRole('menuitem', { name: 'Share' }));
await user.click(screen.getByRole('button', { name: 'Create share' }));
expect(await screen.findByLabelText('Share link')).toHaveValue(expect.stringContaining('/s/'));
expect(screen.queryByText(/providerItemId|tokenHash|passwordHash/)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `npm run test:ui -- tests/ui/shares.test.tsx tests/ui/admin-layout.test.tsx tests/ui/explorer.test.tsx`

Expected: FAIL because share actions and pages are absent.

- [ ] **Step 3: Implement focused share administration components**

Use Lucide `Share2`, `Copy`, `Shield`, `CalendarClock`, `Power`, `Pencil`, and `Trash2` icons. `ShareDialog` uses a checkbox for downloads, a checkbox plus password input for protection, a checkbox plus `datetime-local` input for expiration, and a copy button for the one-time result. `ShareManager` uses the existing compact administration table pattern and a mobile row layout without nested cards.

Add bilingual messages for all labels, status values, confirmation text, and stable Worker errors. Preserve focus trapping, Escape handling, reduced motion, and 390px viewport fit.

- [ ] **Step 4: Verify GREEN and UI suite**

Run: `npm run test:ui`

Expected: all UI tests PASS.

- [ ] **Step 5: Commit administrator UI**

```bash
git add src/ui/types/shares.ts src/ui/api/shares.ts src/ui/features/shares/ShareDialog.tsx src/ui/features/shares/ShareManager.tsx src/ui/features/explorer/EntryActionMenu.tsx src/ui/app/ExplorerPage.tsx src/ui/app/AdminLayout.tsx src/ui/app/ExplorerApp.tsx src/ui/i18n/messages.ts src/ui/i18n/apiErrors.ts src/ui/styles/admin.css src/ui/styles/overlays.css tests/ui/shares.test.tsx tests/ui/admin-layout.test.tsx tests/ui/explorer.test.tsx
git commit -m "feat: manage file shares in the web ui"
```

### Task 7: Public Share Page and Reusable Preview URLs

**Files:**
- Create: `src/ui/api/public-shares.ts`
- Create: `src/ui/app/SharePage.tsx`
- Create: `src/ui/features/shares/SharePasswordForm.tsx`
- Modify: `src/ui/features/preview/PreviewOverlay.tsx`
- Modify: `src/ui/features/explorer/ExplorerCollection.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `src/ui/i18n/apiErrors.ts`
- Modify: `src/ui/styles/explorer.css`
- Modify: `src/ui/styles/responsive.css`
- Create: `tests/ui/public-shares.test.tsx`
- Modify: `tests/ui/preview.test.tsx`
- Modify: `tests/ui/responsive-and-accessibility.test.tsx`

**Interfaces:**
- `PreviewOverlay` gains `urlFor?: (entry, download) => string` and `allowDownload?: boolean`, defaulting to existing behavior.
- `SharePage` consumes `/s/:token/api*`, never administrator session state, and renders file or folder targets.

- [ ] **Step 1: Write failing public-page tests**

Test password challenge, wrong-password feedback, folder list and grid navigation, share-root breadcrumbs, file preview, hidden download controls, direct download links when allowed, expired, disabled, missing-target, provider-unavailable, loading, empty, and mobile behavior.

```tsx
render(<SharePage token="public-token" />);
expect(await screen.findByRole('heading', { name: 'Protected share' })).toBeVisible();
await user.type(screen.getByLabelText('Password'), 'correct-pass');
await user.click(screen.getByRole('button', { name: 'Open share' }));
expect(await screen.findByText('Shared folder')).toBeVisible();
expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `npm run test:ui -- tests/ui/public-shares.test.tsx tests/ui/preview.test.tsx tests/ui/responsive-and-accessibility.test.tsx`

Expected: FAIL because `SharePage` and injectable preview URLs do not exist.

- [ ] **Step 3: Implement the public share experience**

Route `/s/:token` before administrator and explorer paths. Reuse `ExplorerCollection`, file icons, sorting, list/grid preference, and `PreviewOverlay`, but omit search mutations, selection, upload, context management actions, and provider branding. Keep breadcrumbs rooted at the share name; use sealed handles only in API query parameters and share file URLs.

Render dedicated full-width states for password, expired, disabled, missing target, and provider unavailable. Use the existing app header branding without exposing login or admin actions on the share page.

- [ ] **Step 4: Verify GREEN, accessibility, and production build**

Run: `npm run test:ui && npm run build && npx tsc --noEmit`

Expected: all commands PASS.

- [ ] **Step 5: Commit the public UI**

```bash
git add src/ui/api/public-shares.ts src/ui/app/SharePage.tsx src/ui/features/shares/SharePasswordForm.tsx src/ui/features/preview/PreviewOverlay.tsx src/ui/features/explorer/ExplorerCollection.tsx src/ui/app/ExplorerApp.tsx src/ui/i18n/messages.ts src/ui/i18n/apiErrors.ts src/ui/styles/explorer.css src/ui/styles/responsive.css tests/ui/public-shares.test.tsx tests/ui/preview.test.tsx tests/ui/responsive-and-accessibility.test.tsx
git commit -m "feat: add public share browsing"
```

### Task 8: Browser Coverage, Documentation, Deployment, and v0.1.5 Release

**Files:**
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/ilist.spec.ts`
- Modify: `tests/e2e/visual.spec.ts`
- Create: `tests/e2e/visual.spec.ts-snapshots/*share*.png`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- No new runtime interfaces; this task verifies and publishes Tasks 1-7.

- [ ] **Step 1: Add failing Playwright workflows and visual scenarios**

Add administrator create/copy/edit/disable/delete, password unlock, folder navigation, preview, download-denied, expired, disabled, and unavailable flows. Add deterministic desktop, tablet, and 390px mobile screenshots for share dialog, share manager, password page, shared folder list/grid, file preview, and unavailable states.

- [ ] **Step 2: Run browser tests and verify RED before fixture completion**

Run: `npm run test:e2e && npm run test:visual`

Expected: new share scenarios FAIL until fixtures and snapshots match the implemented APIs and UI.

- [ ] **Step 3: Complete fixtures, snapshots, docs, and version metadata**

Update both READMEs with share capabilities, policy behavior, routes, security model, migration `0014_shares.sql`, and limitations. Set package and lockfile version to `0.1.5`. State that share links are revocable, not CDN cached, and do not support uploads or access quotas.

- [ ] **Step 4: Run the complete local release gate**

Run:

```bash
npm run check
npm run test:e2e
npm run test:visual
git diff --check
```

Expected: TypeScript, production build, all Worker/UI tests, browser tests, visual tests, and whitespace checks PASS.

- [ ] **Step 5: Back up and migrate production D1**

Run an export before mutation:

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-v0.1.5.sql
shasum -a 256 /tmp/ilist-db-before-v0.1.5.sql
npx wrangler d1 migrations apply ilist-db --remote
```

Expected: backup is non-empty with a recorded SHA-256; only `0014_shares.sql` is newly applied.

- [ ] **Step 6: Deploy and run production smoke tests**

Run `npm run deploy`, then verify homepage 200, unauthenticated admin shares 401, authenticated create/list/update, password unlock, private native R2 file preview, denied direct download, disable immediate denial, deletion immediate denial, and cleanup of the temporary share and file. Repeat target resolution against the connected OneDrive mount without modifying permanent provider data.

- [ ] **Step 7: Commit release metadata, push, and publish**

```bash
git add README.md README.zh.md package.json package-lock.json tests/e2e
git commit -m "chore: release v0.1.5"
git push origin main
gh release create v0.1.5 --target main --title "ilist v0.1.5" --notes-file /tmp/ilist-v0.1.5-release.md
```

Expected: GitHub reports a stable, non-draft, non-prerelease `v0.1.5`; local `HEAD` equals `origin/main`.

## Plan Self-Review

- Spec coverage: share records, token hashing, passwords, expiration, download policy, enable/disable/delete, private targets, native and external mounts, management UI, public UI, unavailable states, tests, migration, deployment, and release are each assigned to a task.
- Placeholder scan: no implementation placeholder or deferred requirement remains.
- Type consistency: the plan consistently uses `Share`, sealed item handles, `/api/admin/shares`, and `/s/:token/*`; public APIs never consume raw provider IDs.
- Scope: Google Drive, uploads through shares, recipient accounts, quotas, counters, and cross-mount operations remain outside `v0.1.5`.
