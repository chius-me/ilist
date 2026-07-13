# ilist Multi-Mount Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenList-style multi-mount storage with user-named S3-compatible and OneDrive Personal mounts while preserving all existing native R2 content and links.

**Architecture:** Virtual paths resolve their first segment through D1 mount records and delegate provider operations to a common `StorageDriver`. S3-compatible credentials and OneDrive OAuth tokens are AES-GCM encrypted in D1; the current native R2 implementation remains a compatibility backend until a later migration.

**Tech Stack:** Cloudflare native Workers, TypeScript, D1, Workers Assets, Web Crypto, Microsoft Graph REST, AWS Signature Version 4, React/Vite, Vitest with Cloudflare Workers pool.

## Global Constraints

- Do not add Hono, an ORM, the AWS SDK, or the Microsoft Graph SDK.
- Preserve existing `/file/:id/:name`, legacy `/file/<key>`, public listing, and native `R2_BUCKET` behavior.
- OneDrive scope is personal Microsoft accounts only through the `consumers` tenant.
- OneDrive scopes are exactly `offline_access User.Read Files.ReadWrite`.
- Mount paths are unique single top-level path segments; `api`, `file`, and `admin` are reserved.
- Provider secrets, OAuth tokens, and preauthenticated download URLs must never be returned by APIs or logged.
- Follow test-driven development for every behavior change.

---

### Task 1: Mount Schema and Domain Model

**Files:**
- Create: `migrations/0008_mounts.sql`
- Create: `src/worker/mounts.ts`
- Modify: `src/worker/types.ts`
- Modify: `tests/worker/setup.ts`
- Create: `tests/worker/mounts.test.ts`
- Create: `tests/worker/mounts-schema.test.ts`

**Interfaces:**
- Produces: `MountRow`, `Mount`, `MountDriverType`, `normalizeMountPath()`, `listMounts()`, `getMount()`, `createMount()`, `updateMount()`, and `deleteMount()`.
- Constraint: deletion removes configuration only and never invokes provider deletion.

- [ ] **Step 1: Write failing schema and domain tests**

```ts
it('rejects duplicate and reserved mount paths', async () => {
  await createMount(env.DB, { name: 'Photos', mountPath: '/photos', driverType: 's3', provider: 'cloudflare-r2' });
  await expect(createMount(env.DB, { name: 'Other', mountPath: '/photos', driverType: 's3', provider: 'custom' })).rejects.toMatchObject({ status: 409 });
  expect(() => normalizeMountPath('/api')).toThrow('reserved');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run test:worker -- tests/worker/mounts-schema.test.ts tests/worker/mounts.test.ts`

Expected: FAIL because migration `0008` and mount functions do not exist.

- [ ] **Step 3: Add the migration and minimal mount repository**

Create `mounts` with `id`, `name`, `mount_path`, `driver_type`, `provider`, `enabled`, `is_public`, `sort_order`, `root_item_id`, `config_json`, `created_at`, and `updated_at`. Add unique indexes for `mount_path` and normalized names. Validate one decoded segment, leading slash, control characters, and reserved names in `normalizeMountPath()`.

- [ ] **Step 4: Verify focused and full Worker suites GREEN**

Run: `npm run test:worker -- tests/worker/mounts-schema.test.ts tests/worker/mounts.test.ts && npm run test:worker`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add migrations/0008_mounts.sql src/worker/mounts.ts src/worker/types.ts tests/worker/setup.ts tests/worker/mounts*.test.ts
git commit -m "feat: add multi-mount domain model"
```

### Task 2: Encrypted Credential Storage

**Files:**
- Create: `migrations/0009_storage_credentials.sql`
- Create: `src/worker/crypto.ts`
- Create: `src/worker/credentials.ts`
- Modify: `src/worker/types.ts`
- Modify: `vitest.worker.config.ts`
- Create: `tests/worker/credentials.test.ts`

**Interfaces:**
- Consumes: mount IDs from Task 1.
- Produces: `encryptCredential(value, masterKey)`, `decryptCredential(envelope, masterKey)`, `putCredentials()`, `getCredentials()`, and `deleteCredentials()`.

- [ ] **Step 1: Write failing encryption tests**

```ts
it('round trips credentials without storing plaintext', async () => {
  await putCredentials(env, mountId, { accessKeyId: 'key', secretAccessKey: 'secret' });
  const row = await env.DB.prepare('SELECT ciphertext FROM storage_credentials WHERE mount_id = ?').bind(mountId).first<{ ciphertext: string }>();
  expect(row?.ciphertext).not.toContain('secret');
  await expect(getCredentials(env, mountId)).resolves.toEqual({ accessKeyId: 'key', secretAccessKey: 'secret' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/credentials.test.ts`

Expected: FAIL because credential storage is missing.

- [ ] **Step 3: Implement AES-GCM envelopes**

Use a 32-byte base64 `CREDENTIAL_MASTER_KEY`, random 12-byte IV, versioned JSON envelope, and mount ID as additional authenticated data. Add the binding to `Env` and a deterministic test key to the Worker test config.

- [ ] **Step 4: Verify GREEN and malformed-data failure**

Run: `npm run test:worker -- tests/worker/credentials.test.ts && npm run test:worker`

Expected: round trip passes; wrong key, changed mount ID, and malformed ciphertext fail closed.

- [ ] **Step 5: Commit**

```bash
git add migrations/0009_storage_credentials.sql src/worker/crypto.ts src/worker/credentials.ts src/worker/types.ts vitest.worker.config.ts tests/worker/credentials.test.ts
git commit -m "feat: encrypt storage credentials"
```

### Task 3: Common Driver Contract and Mount Resolver

**Files:**
- Create: `src/worker/drivers/types.ts`
- Create: `src/worker/drivers/registry.ts`
- Create: `src/worker/mount-resolver.ts`
- Create: `tests/worker/mount-resolver.test.ts`

**Interfaces:**
- Consumes: `Mount` from Task 1 and credentials from Task 2.
- Produces: `StorageDriver`, `StorageItem`, `ListResult`, `DownloadResult`, `resolveVirtualPath()`, and `createDriver()`.

- [ ] **Step 1: Write failing resolver tests**

```ts
it('resolves a named mount and preserves the provider-relative path', () => {
  expect(resolveVirtualPath('/Personal Drive/Documents', mounts)).toEqual({
    mount: mounts[0],
    relativePath: '/Documents',
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/mount-resolver.test.ts`

Expected: FAIL because resolver and driver types are absent.

- [ ] **Step 3: Implement contract, capability sets, and resolver**

Use decoded virtual path segments, exact top-level matching, and stable errors `MOUNT_NOT_FOUND`, `MOUNT_DISABLED`, and `DRIVER_UNAVAILABLE`. Registry factories receive only `env`, mount metadata, and decrypted credentials.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:worker -- tests/worker/mount-resolver.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add src/worker/drivers src/worker/mount-resolver.ts tests/worker/mount-resolver.test.ts
git commit -m "feat: add storage driver contract"
```

### Task 4: Mount Administration API

**Files:**
- Create: `src/worker/mount-routes.ts`
- Modify: `src/worker/router.ts`
- Modify: `tests/worker/router.test.ts`
- Create: `tests/worker/mount-routes.test.ts`

**Interfaces:**
- Consumes: mount and credential repositories.
- Produces: authenticated CRUD routes under `/api/admin/mounts` and sanitized response objects.

- [ ] **Step 1: Write failing API tests**

```ts
it('never returns stored credentials', async () => {
  const response = await adminFetch('/api/admin/mounts');
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain('secretAccessKey');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/mount-routes.test.ts`

- [ ] **Step 3: Implement CRUD, test, and disconnect routes**

Validate driver-specific public config and credentials. Blank secret fields preserve existing values. `DELETE` removes credentials and mount rows only. Return `409 MOUNT_PATH_CONFLICT` for collisions.

- [ ] **Step 4: Verify GREEN and authorization coverage**

Run: `npm run test:worker -- tests/worker/mount-routes.test.ts tests/worker/router.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add src/worker/mount-routes.ts src/worker/router.ts tests/worker/mount-routes.test.ts tests/worker/router.test.ts
git commit -m "feat: add mount administration api"
```

### Task 5: Virtual Root and Native R2 Compatibility Mount

**Files:**
- Create: `migrations/0010_native_r2_compat_mount.sql`
- Modify: `src/worker/file-system.ts`
- Modify: `src/worker/router.ts`
- Modify: `src/worker/types.ts`
- Modify: `tests/worker/file-system.test.ts`
- Modify: `tests/worker/router.test.ts`

**Interfaces:**
- Consumes: mount resolver and existing entry APIs.
- Produces: root mount entries and compatibility routing that leaves stable legacy IDs untouched.

- [ ] **Step 1: Write failing compatibility tests**

```ts
it('lists enabled public mounts at root while old stable file links still work', async () => {
  const root = await guestFetch('/api/fs/list?path=/');
  expect(await root.json()).toMatchObject({ data: { items: expect.arrayContaining([expect.objectContaining({ name: 'R2', kind: 'folder' })]) } });
  expect((await guestFetch(`/file/${legacyEntryId}/file.txt`)).status).toBe(200);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/file-system.test.ts tests/worker/router.test.ts`

- [ ] **Step 3: Add compatibility mount and virtual-root dispatch**

Insert one deterministic `native-r2` mount only when absent. Keep current root entry data reachable beneath that mount without changing storage keys or stable file routes. Provider failure must not prevent root mount listing.

- [ ] **Step 4: Verify GREEN and migration idempotency**

Run: `npm run test:worker -- tests/worker/file-system.test.ts tests/worker/router.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add migrations/0010_native_r2_compat_mount.sql src/worker/file-system.ts src/worker/router.ts src/worker/types.ts tests/worker/file-system.test.ts tests/worker/router.test.ts
git commit -m "feat: expose virtual storage mounts"
```

### Task 6: AWS Signature V4 and S3 HTTP Client

**Files:**
- Create: `src/worker/drivers/s3/signing.ts`
- Create: `src/worker/drivers/s3/client.ts`
- Create: `src/worker/drivers/s3/xml.ts`
- Create: `tests/worker/s3-signing.test.ts`
- Create: `tests/worker/s3-client.test.ts`

**Interfaces:**
- Produces: `signS3Request()`, `S3Client.listObjectsV2()`, `headObject()`, `getObject()`, `putObject()`, `copyObject()`, and `deleteObject()`.

- [ ] **Step 1: Write failing official-vector and XML tests**

Use fixed credentials, timestamp, canonical request, and expected authorization signature. Test encoded Unicode keys, continuation tokens, common prefixes, and S3 XML errors.

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/s3-signing.test.ts tests/worker/s3-client.test.ts`

- [ ] **Step 3: Implement Workers-compatible SigV4 and structured XML parsing**

Use Web Crypto HMAC-SHA256. Use `XMLParser` from a small Workers-compatible dependency only if native structured parsing is unavailable; do not parse XML with regular expressions. Preserve opaque continuation tokens.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:worker -- tests/worker/s3-signing.test.ts tests/worker/s3-client.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/worker/drivers/s3 tests/worker/s3-*.test.ts
git commit -m "feat: add s3 compatible client"
```

### Task 7: S3 Storage Driver

**Files:**
- Create: `src/worker/drivers/s3/driver.ts`
- Modify: `src/worker/drivers/registry.ts`
- Create: `tests/worker/s3-driver.test.ts`

**Interfaces:**
- Consumes: S3 client and common driver contract.
- Produces: full `S3Driver` with prefix-folder semantics and copy-before-delete moves.

- [ ] **Step 1: Write failing behavior tests**

Cover root prefix isolation, list pagination, empty folders, upload, folder creation, rename, move, recursive delete, download streaming, and copy failure preserving the source.

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/s3-driver.test.ts`

- [ ] **Step 3: Implement the driver**

Represent item IDs as reversible, versioned base64url keys scoped to the mount. Use zero-byte trailing-slash objects for explicit empty folders. Stream bodies without buffering. Reject operations escaping the configured root prefix.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:worker -- tests/worker/s3-driver.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add src/worker/drivers/s3/driver.ts src/worker/drivers/registry.ts tests/worker/s3-driver.test.ts
git commit -m "feat: add s3 storage driver"
```

### Task 8: Storage Management UI

**Files:**
- Create: `src/ui/api/mounts.ts`
- Create: `src/ui/types/mounts.ts`
- Create: `src/ui/features/mounts/MountManager.tsx`
- Create: `src/ui/features/mounts/MountDialog.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Modify: `src/ui/styles.css`
- Create: `tests/ui/mounts.test.tsx`
- Modify: `tests/ui/responsive-and-accessibility.test.tsx`

**Interfaces:**
- Consumes: mount administration API.
- Produces: `/admin/storages` management view and S3 provider preset form.

- [ ] **Step 1: Write failing UI tests**

Test listing, add/edit, preserved blank secret, disable, delete confirmation, keyboard operation, mobile layout, and absence of credential values in rendered output.

- [ ] **Step 2: Verify RED**

Run: `npm run test:ui -- tests/ui/mounts.test.tsx`

- [ ] **Step 3: Implement management view**

Use the existing restrained visual system, icon buttons with tooltips, no nested cards, and a responsive full-width list. Presets populate endpoint defaults while retaining editable fields.

- [ ] **Step 4: Verify GREEN and responsive coverage**

Run: `npm run test:ui -- tests/ui/mounts.test.tsx tests/ui/responsive-and-accessibility.test.tsx && npm run test:ui`

- [ ] **Step 5: Commit**

```bash
git add src/ui/api/mounts.ts src/ui/types/mounts.ts src/ui/features/mounts src/ui/app/ExplorerApp.tsx src/ui/styles.css tests/ui/mounts.test.tsx tests/ui/responsive-and-accessibility.test.tsx
git commit -m "feat: add storage mount management ui"
```

### Task 9: OneDrive OAuth and Token Lifecycle

**Files:**
- Create: `migrations/0011_oauth_states.sql`
- Create: `src/worker/drivers/onedrive/oauth.ts`
- Create: `src/worker/drivers/onedrive/tokens.ts`
- Create: `src/worker/oauth-routes.ts`
- Modify: `src/worker/router.ts`
- Modify: `src/worker/types.ts`
- Create: `tests/worker/onedrive-oauth.test.ts`
- Create: `tests/worker/onedrive-tokens.test.ts`

**Interfaces:**
- Consumes: encrypted credential storage and mount IDs.
- Produces: PKCE start/callback routes and `getOneDriveAccessToken(env, mountId)`.

- [ ] **Step 1: Write failing OAuth tests**

Cover `consumers` authorize URL, exact scopes, state expiry, replay rejection, callback origin allowlist, encrypted token persistence, refresh rotation, and concurrent refresh lease behavior.

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/onedrive-oauth.test.ts tests/worker/onedrive-tokens.test.ts`

- [ ] **Step 3: Implement OAuth and refresh flow**

Use Web Crypto PKCE S256. Store only hashed state identifiers and encrypted verifier data. Read `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `PUBLIC_ORIGIN` from Worker secrets/vars. Never expose token endpoint response bodies in errors.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:worker -- tests/worker/onedrive-oauth.test.ts tests/worker/onedrive-tokens.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add migrations/0011_oauth_states.sql src/worker/drivers/onedrive src/worker/oauth-routes.ts src/worker/router.ts src/worker/types.ts tests/worker/onedrive-*.test.ts
git commit -m "feat: connect onedrive personal accounts"
```

### Task 10: OneDrive Graph Client and Read Driver

**Files:**
- Create: `src/worker/drivers/onedrive/client.ts`
- Create: `src/worker/drivers/onedrive/mapper.ts`
- Create: `src/worker/drivers/onedrive/driver.ts`
- Modify: `src/worker/drivers/registry.ts`
- Create: `tests/worker/onedrive-driver.test.ts`

**Interfaces:**
- Consumes: access token lifecycle and common driver contract.
- Produces: OneDrive `list`, `stat`, and `getDownload` operations.

- [ ] **Step 1: Write failing Graph mapping tests**

Cover root and child listing, `@odata.nextLink` opaque cursors, folders/files/packages, Unicode names, Graph errors, expired-token retry once, and preauthenticated download redirects.

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/onedrive-driver.test.ts`

- [ ] **Step 3: Implement read operations**

Use `/me/drive/root` and `/me/drive/items/{id}/children` with explicit `$select`. Encode item IDs as path segments, never interpolate raw IDs. Fetch `@microsoft.graph.downloadUrl` immediately and do not cache it.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:worker -- tests/worker/onedrive-driver.test.ts && npm run test:worker`

- [ ] **Step 5: Commit**

```bash
git add src/worker/drivers/onedrive src/worker/drivers/registry.ts tests/worker/onedrive-driver.test.ts
git commit -m "feat: browse and download onedrive files"
```

### Task 11: OneDrive Write Operations

**Files:**
- Modify: `src/worker/drivers/onedrive/client.ts`
- Modify: `src/worker/drivers/onedrive/driver.ts`
- Modify: `tests/worker/onedrive-driver.test.ts`
- Modify: `src/ui/features/uploads/useUploadQueue.ts`
- Modify: `tests/ui/uploads.test.tsx`

**Interfaces:**
- Produces: create folder, single-request upload, rename, move, and delete for OneDrive Personal.

- [ ] **Step 1: Write failing write-operation tests**

Cover conflict behavior, encoded names, parent references, delete `204`, Graph conflict mapping, streamed upload, and UI refresh after completion.

- [ ] **Step 2: Verify RED**

Run: `npm run test:worker -- tests/worker/onedrive-driver.test.ts && npm run test:ui -- tests/ui/uploads.test.tsx`

- [ ] **Step 3: Implement write operations and route them through capabilities**

Use Graph DriveItem update for rename/move, children POST for folders, content PUT for current single-request uploads, and DELETE for removal. Do not add resumable uploads in this release.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:worker -- tests/worker/onedrive-driver.test.ts && npm run test:ui -- tests/ui/uploads.test.tsx && npm test`

- [ ] **Step 5: Commit**

```bash
git add src/worker/drivers/onedrive tests/worker/onedrive-driver.test.ts src/ui/features/uploads/useUploadQueue.ts tests/ui/uploads.test.tsx
git commit -m "feat: manage onedrive files"
```

### Task 12: OneDrive Connection UI

**Files:**
- Modify: `src/ui/features/mounts/MountDialog.tsx`
- Modify: `src/ui/features/mounts/MountManager.tsx`
- Modify: `src/ui/api/mounts.ts`
- Modify: `src/ui/styles.css`
- Modify: `tests/ui/mounts.test.tsx`

**Interfaces:**
- Consumes: OAuth start/disconnect routes.
- Produces: OneDrive mount creation, connect, reconnect, callback status, and disconnect UI.

- [ ] **Step 1: Write failing connection-state tests**

Test disconnected, connecting, connected account, callback error, reconnect, disconnect confirmation, and mobile presentation.

- [ ] **Step 2: Verify RED**

Run: `npm run test:ui -- tests/ui/mounts.test.tsx`

- [ ] **Step 3: Implement OneDrive form and connection states**

Create the mount before OAuth, then redirect to the server-generated authorization URL. On callback return, show a concise success/error status and return to `/admin/storages`.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:ui -- tests/ui/mounts.test.tsx && npm run test:ui`

- [ ] **Step 5: Commit**

```bash
git add src/ui/features/mounts src/ui/api/mounts.ts src/ui/styles.css tests/ui/mounts.test.tsx
git commit -m "feat: add onedrive connection workflow"
```

### Task 13: Documentation, Migration, and Release Verification

**Files:**
- Modify: `.dev.vars.example`
- Modify: `README.md`
- Modify: `wrangler.jsonc`
- Create: `docs/onedrive-setup.md`
- Create: `tests/worker/multi-mount-integration.test.ts`

**Interfaces:**
- Produces: operator setup instructions and release evidence.

- [ ] **Step 1: Add failing end-to-end integration tests**

Test guest/admin virtual roots, two mounts of the same type, disabled/private mounts, provider failure isolation, stable compatibility links, S3 CRUD, and mocked OneDrive CRUD in one suite.

- [ ] **Step 2: Verify RED, then complete integration dispatch**

Run: `npm run test:worker -- tests/worker/multi-mount-integration.test.ts`

Update `src/worker/router.ts` and `src/worker/file-system.ts` so root requests use `listMounts()`, mounted paths use `resolveVirtualPath()` and `createDriver()`, and file/admin operations dispatch through driver capabilities. Wrap each provider call independently and translate failures through the existing JSON error response without suppressing healthy mounts.

- [ ] **Step 3: Document exact Cloudflare and Microsoft setup**

Document D1 migrations, `CREDENTIAL_MASTER_KEY`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `PUBLIC_ORIGIN`, Microsoft redirect URI, `consumers` account type, required scopes, S3 presets, backup, rollback, and compatibility behavior.

- [ ] **Step 4: Run complete local verification**

Run:

```bash
npm run check
npx wrangler d1 migrations apply DB --local
npm run migrate:objects
```

Expected: TypeScript, build, all Worker/UI tests, migrations, and legacy import pass. Verify desktop `1440x900` and mobile `390x844` screenshots with no overlap or clipping.

- [ ] **Step 5: Prepare production rollout without changing credentials**

Export remote D1, apply migrations, verify mount/entry counts, deploy, smoke guest behavior and compatibility links, then request Microsoft app credentials before OAuth production smoke. Never reset existing secrets during this step.

- [ ] **Step 6: Commit**

```bash
git add .dev.vars.example README.md wrangler.jsonc docs/onedrive-setup.md tests/worker/multi-mount-integration.test.ts
git commit -m "docs: prepare multi-mount storage release"
```

## Deferred Follow-Up

- OneDrive resumable upload sessions and pause/resume UI.
- Cross-mount copy and move.
- Google Drive, WebDAV, and work/school Microsoft accounts.
- Removal of the native R2 compatibility binding after a separately approved data migration.
