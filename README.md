# ilist

ilist is a lightweight Cloudflare Workers file explorer. D1 stores a virtual filesystem of file and folder entries, including visibility and metadata. R2 stores file blobs under immutable entry storage keys. The Worker joins those layers for browsing, administration, previews, downloads, and stable file URLs.

## Stack

- Cloudflare native Worker and Workers Assets
- D1 binding: `DB`
- R2 bucket binding: `R2_BUCKET`
- React + Vite frontend

## Local Setup

Install dependencies and create local secrets:

```bash
npm install
npm run hash-password -- "your-admin-password"
cp .dev.vars.example .dev.vars
```

Set the generated password hash and a unique, 32-character-or-longer session secret in `.dev.vars`:

```env
ADMIN_PASSWORD_HASH=pbkdf2:210000:replace_with_salt_hex:replace_with_hash_hex
SESSION_SECRET=replace-with-at-least-32-random-characters
```

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

The explorer uses URL paths to address directories and entry IDs to address files:

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

Before deployment, record the export location and expected legacy-object count. After the import, confirm all imported entries are `ready`, compare the entry and object counts, deploy, and run authenticated and guest smoke tests. At minimum verify the root explorer, nested-path refresh, stable file link, guest access to hidden entries, admin login, a small disposable upload and delete, and the deployed API responses:

```bash
curl -i 'https://ilist.chius.workers.dev/api/fs/list?path=/'
curl -i https://ilist.chius.workers.dev/api/admin/me
```

The public directory response should be `200`; unauthenticated `me` should be `401` with `AUTH_REQUIRED`. Do not commit credentials, D1 exports, temporary uploads, or deployment-only artifacts.
