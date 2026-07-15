# ilist

ilist is a lightweight, OpenList-style file explorer built on Cloudflare Workers. A virtual root can contain multiple user-named OneDrive Personal and S3-compatible mounts, including Cloudflare R2. The original bound R2 bucket remains available as the built-in `R2` compatibility mount.

## Stack

- Cloudflare native Worker and Workers Assets
- D1 binding: `DB`
- R2 bucket binding: `R2_BUCKET`
- React + Vite frontend
- Microsoft Graph REST and S3 Signature V4 without provider SDKs

## Local Setup

Install dependencies and create local secrets:

```bash
npm install
npm run hash-password -- "your-admin-password"
cp .dev.vars.example .dev.vars
```

Generate the remaining local keys:

```bash
openssl rand -base64 32 # CREDENTIAL_MASTER_KEY
openssl rand -hex 32    # SESSION_SECRET
```

Set the generated values and Microsoft application settings in `.dev.vars`. `PUBLIC_ORIGIN` must be one exact HTTPS origin without a trailing slash. OAuth cannot complete against Wrangler's default plain-HTTP local URL; use the deployed Worker or an HTTPS development hostname.

```env
ADMIN_PASSWORD_HASH=pbkdf2:210000:replace_with_salt_hex:replace_with_hash_hex
CREDENTIAL_MASTER_KEY=replace-with-32-byte-base64-key
SESSION_SECRET=replace-with-at-least-32-random-characters
MICROSOFT_CLIENT_ID=replace-with-application-client-id
MICROSOFT_CLIENT_SECRET=replace-with-application-client-secret
PUBLIC_ORIGIN=https://ilist.example.com
```

See [OneDrive setup](docs/onedrive-setup.md) for the Microsoft app registration and production secret procedure.

Apply every D1 migration to the local database, then migrate the retained legacy object index. Run the import twice: the second invocation proves the import is idempotent.

```bash
npx wrangler d1 migrations apply ilist-db --local
npm run migrate:objects -- --local
npm run migrate:objects -- --local
npx wrangler d1 execute ilist-db --local --command "SELECT kind, status, COUNT(*) AS count FROM entries GROUP BY kind, status"
```

Run the suites and start the local Worker:

```bash
npm run test
npm run check
npm run dev
```

The Worker runs locally at the URL printed by Wrangler, normally `http://localhost:8787`. Local R2 and D1 bindings are used; no Cloudflare resources are changed by these commands.

## Filesystem API

The explorer uses URL paths to address directories and opaque entry IDs to address files. External IDs contain both the mount identity and provider item identity, so the same provider ID can safely exist in several mounts:

- `GET /api/fs/list?path=/path/to/folder` lists a directory for the current guest or admin session.
- `GET /api/fs/entries/:id` returns an entry when it is visible to the caller.
- `GET` or `HEAD /file/:id/:name` opens a stable file URL. Add `?download=1` to request a download disposition.

Admin session routes:

- `POST /api/admin/login`, `POST /api/admin/logout`, and `GET /api/admin/me`
- `POST /api/admin/folders`
- `PUT /api/admin/files/:id?parentId=:parentId&name=:name`
- `PATCH /api/admin/entries/:id`
- `POST /api/admin/entries/move`, `/api/admin/entries/delete`, and `/api/admin/entries/visibility`

Top-level entry names `api`, `file`, and `admin` are reserved because they would collide with Worker routes. The same names are valid below the root.

## Storage Mounts

Administrators manage mounts from `/admin/storages`. Every mount has its own display name, top-level path, guest visibility, connection, and optional provider root.

- **OneDrive Personal:** create a named mount, then complete Microsoft authorization. Multiple mounts can connect different personal Microsoft accounts.
- **Cloudflare R2:** use endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`, path-style addressing, bucket name, and bucket-scoped S3 credentials.
- **Other S3-compatible storage:** provide the HTTPS endpoint, signing region, bucket, addressing mode, and credentials. A root prefix can expose only one subtree.

Mount deletion removes ilist configuration and encrypted credentials only. It never deletes the provider bucket or drive. Cross-mount move/copy and resumable uploads are not part of this release.

Uploads are single, non-resumable Worker requests. The practical maximum is the Cloudflare request-body limit for the zone plan (100 MB on Free and Pro, 200 MB on Business, and 500 MB by default on Enterprise); larger or interruption-tolerant uploads require a multipart design. Recursive deletion processes at most 1000 entries per requested tree by default and reports per-entry failures when a tree exceeds that limit.

## Compatibility Release

The `objects` table remains for one compatibility release. It is the source for the legacy object routes and legacy `/file/<old-key>` links; old file links resolve the decoded stored key through `findEntryByStorageKey()` and redirect to the stable entry URL. Do not drop `objects` or its migration/import support until the compatibility release has ended.

The current explorer does not use the old flat UI API or the legacy `/api/public/tree`, `/api/public/object`, and `/api/admin/objects` routes. The Worker keeps the legacy endpoints temporarily so existing integrations and file links continue to work during the release window.

## Production Rollout

Perform this sequence only after confirming the target account, credentials, and deployment intent. Keep the database export outside the repository.

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-entries.sql
npx wrangler d1 migrations apply ilist-db --remote
npm run migrate:objects -- --remote
npx wrangler d1 execute ilist-db --remote --command "SELECT kind, status, COUNT(*) AS count FROM entries GROUP BY kind, status"
npx wrangler d1 execute ilist-db --remote --command "SELECT COUNT(*) AS old_count FROM objects"
npm run deploy
```

Before the first multi-mount deployment, configure all six required Worker secrets listed in `wrangler.jsonc`. Wrangler preserves existing secrets during normal code deployments. Keep `CREDENTIAL_MASTER_KEY` stable: changing it makes stored S3 credentials and OneDrive tokens unreadable.

Before deployment, record the export location and expected legacy-object count. After the import, confirm all imported entries are `ready`, compare the entry and object counts, deploy, and run authenticated and guest smoke tests. At minimum verify the root explorer, nested-path refresh, stable file link, guest access to hidden entries, admin login, a small disposable upload and delete, and the deployed API responses:

```bash
curl -i 'https://ilist.chius.workers.dev/api/fs/list?path=/'
curl -i https://ilist.chius.workers.dev/api/admin/me
```

The public directory response should be `200`; unauthenticated `me` should be `401` with `AUTH_REQUIRED`. Do not commit credentials, D1 exports, temporary uploads, or deployment-only artifacts.
