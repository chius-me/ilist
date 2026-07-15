# ilist

ilist is a lightweight, self-hosted file index and manager built for Cloudflare Workers. It provides an OpenList-inspired browser for multiple user-named OneDrive Personal and S3-compatible mounts, including Cloudflare R2.

The application runs as a native Cloudflare Worker without a server framework. React assets are served through Workers Assets, metadata and sessions are stored in D1, and the bundled R2 binding remains available as a built-in compatibility mount.

> **Release status:** `v0.1.0` is the first usable release. It is intended for a single administrator and public read-only browsing. Review the limitations and back up D1 before upgrading.

## Features

- Virtual root with multiple independently named storage mounts
- OneDrive Personal OAuth authorization with PKCE and encrypted refresh tokens
- Multiple OneDrive accounts, each mounted at a custom top-level path
- S3-compatible mounts with AWS Signature Version 4
- Cloudflare R2 through either S3 credentials or the built-in Worker binding
- Public directory browsing, stable file links, downloads, and common file previews
- List and grid views, breadcrumbs, sorting, search, selection, and responsive layout
- Administrator login, upload, folder creation, rename, move, delete, and visibility controls
- D1 migrations and compatibility support for legacy R2 object links
- Streamed provider responses without buffering complete files in Worker memory

## Supported Storage

| Storage | Browse | Download | Upload | Manage | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| OneDrive Personal | Yes | Yes | Yes | Yes | Personal Microsoft accounts only |
| Cloudflare R2 binding | Yes | Yes | Yes | Yes | Built-in `R2` compatibility mount |
| Cloudflare R2 through S3 | Yes | Yes | Yes | Yes | Use the R2 S3 endpoint and scoped credentials |
| Other S3-compatible storage | Yes | Yes | Yes | Yes | Compatibility depends on the provider's S3 implementation |

OneDrive Personal Vault is not exposed. Microsoft Graph returns the locked vault without a usable file or folder facet, so ilist skips it instead of failing the parent directory.

## Architecture

```text
Browser
  |
  +-- React + Vite UI (Workers Assets)
  |
  +-- Cloudflare Worker
        +-- Native request router and session authentication
        +-- Virtual filesystem and storage driver registry
        +-- OneDrive Personal driver -> Microsoft Graph
        +-- S3 driver -> R2 or another S3-compatible provider
        +-- D1 -> mounts, encrypted credentials, entries, sessions
        +-- R2 binding -> built-in compatibility storage
```

The Worker acts as the control plane and streams or redirects file data where possible. Provider credentials are encrypted before they are written to D1.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- A Cloudflare account with Workers, D1, and R2 enabled
- Wrangler authenticated with `npx wrangler login`
- A Microsoft Entra application when using OneDrive Personal

## Quick Start

Install project dependencies:

```bash
git clone https://github.com/chius-me/ilist.git
cd ilist
npm install
```

Create the Cloudflare resources:

```bash
npx wrangler d1 create ilist-db
npx wrangler r2 bucket create ilist-files
```

Copy the D1 `database_id` returned by Wrangler into `wrangler.jsonc`. Change the database and bucket names there as well if you used different names.

Apply the database migrations:

```bash
npx wrangler d1 migrations apply ilist-db --remote
```

Generate the administrator password hash and encryption keys:

```bash
npm run hash-password -- "choose-a-strong-password"
openssl rand -base64 32
openssl rand -hex 32
```

Configure every required Worker secret. Values entered with Wrangler are not written to the repository:

```bash
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put CREDENTIAL_MASTER_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler secret put PUBLIC_ORIGIN
```

`PUBLIC_ORIGIN` must be the exact deployed HTTPS origin without a trailing slash, for example `https://ilist.example.com`.

Build, test, and deploy:

```bash
npm run check
npm run deploy
```

The default administrator username is configured as `admin` in `wrangler.jsonc`. The password is the plaintext value used to generate `ADMIN_PASSWORD_HASH`.

## OneDrive Setup

ilist uses the Microsoft identity platform authorization-code flow with PKCE and the `consumers` tenant.

1. Create an app registration in the Microsoft Entra admin center.
2. Select **Personal Microsoft accounts only** as the supported account type.
3. Add a **Web** redirect URI:

   ```text
   https://YOUR_ILIST_ORIGIN/api/admin/oauth/onedrive/callback
   ```

4. Create a client secret.
5. Add delegated Microsoft Graph permissions `User.Read` and `Files.ReadWrite`.
6. Store the application ID and client secret in the Worker secrets described above.
7. Sign in to ilist, open `/admin/storages`, create a OneDrive mount, and complete authorization.

Do not enable implicit-grant access tokens or ID tokens. See [docs/onedrive-setup.md](docs/onedrive-setup.md) for the full registration, deployment, verification, and rollback procedure.

## Local Development

Create local secrets from the tracked template:

```bash
cp .dev.vars.example .dev.vars
```

Fill in test-only values, then initialize local D1 and start Wrangler:

```bash
npx wrangler d1 migrations apply ilist-db --local
npm run dev
```

Wrangler normally serves the application at `http://localhost:8787`. OAuth cannot complete against that plain-HTTP origin; use a deployed Worker or an HTTPS development hostname for the callback flow.

Local D1 and R2 data are isolated from production. Never put production credentials in `.dev.vars`.

## Storage Management

Open `/admin/storages` after signing in. Each mount has its own:

- Display name and top-level mount path
- Provider and encrypted credentials
- Public or private visibility
- Enabled state and optional provider root

Deleting or disconnecting a mount removes only ilist configuration and credentials. It does not delete the provider account, bucket, drive, or stored objects.

For Cloudflare R2 through S3, use:

```text
Endpoint: https://ACCOUNT_ID.r2.cloudflarestorage.com
Region: auto
Addressing mode: path style
```

Use a bucket-scoped R2 API token with only the permissions ilist requires.

## Filesystem API

Directories are addressed by URL path. Files and folders use opaque entry IDs that include both the mount ID and provider item ID.

Public and session-aware routes:

```text
GET  /api/fs/list?path=/path/to/folder
GET  /api/fs/entries/:id
GET  /file/:id/:name
HEAD /file/:id/:name
```

Append `?download=1` to a file URL to request download disposition.

Administrator routes:

```text
POST   /api/admin/login
POST   /api/admin/logout
GET    /api/admin/me
POST   /api/admin/folders
PUT    /api/admin/files/:id?parentId=:parentId&name=:name
PATCH  /api/admin/entries/:id
POST   /api/admin/entries/move
POST   /api/admin/entries/delete
POST   /api/admin/entries/visibility
GET    /api/admin/mounts
POST   /api/admin/mounts
PATCH  /api/admin/mounts/:id
DELETE /api/admin/mounts/:id
```

The top-level names `api`, `file`, and `admin` are reserved because they collide with Worker routes. The same names are valid below the virtual root.

## Project Layout

```text
src/
  ui/                         React file explorer and admin UI
  worker/
    index.ts                  Native Worker entry point
    router.ts                 HTTP route dispatch
    file-system.ts            Virtual filesystem operations
    drivers/
      onedrive/               Microsoft Graph driver and OAuth tokens
      s3/                     S3-compatible driver and SigV4 client
migrations/                   D1 schema migrations
tests/worker/                 Worker runtime tests
tests/ui/                     React component and interaction tests
docs/                         Setup and implementation documentation
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the local Worker and UI |
| `npm run build` | Build the Vite frontend |
| `npm run test:worker` | Run Worker runtime tests |
| `npm run test:ui` | Run UI tests |
| `npm run test` | Run all tests |
| `npm run check` | Type-check, build, and run all tests |
| `npm run deploy` | Build and deploy with Wrangler |
| `npm run hash-password -- "..."` | Generate an administrator password hash |
| `npm run migrate:objects -- --local` | Import legacy object rows into the entry model locally |
| `npm run migrate:objects -- --remote` | Import legacy object rows in production |

## Limitations

- Single administrator; no registration or multi-user permission model
- OneDrive Personal only; work and school tenants are not yet supported
- No Google Drive, WebDAV, FTP, SFTP, SMB, or local filesystem drivers
- Uploads use one non-resumable Worker request and are subject to Cloudflare request-body limits
- No multipart S3 upload or OneDrive upload session yet
- No cross-mount copy or move
- No offline download, archive extraction, media transcoding, or background task system
- Provider listings are fetched live; distributed directory caching is not implemented
- Recursive deletion is bounded and reports per-entry failures when its safety limit is exceeded

## Security

- Keep `CREDENTIAL_MASTER_KEY` stable. Changing it without a re-encryption migration makes stored provider credentials unreadable.
- Rotate any credential that has appeared in a terminal recording, screenshot, issue, or chat.
- Back up D1 before applying migrations or deploying a new release.
- Use least-privilege, bucket-scoped S3 or R2 credentials.
- Do not commit `.dev.vars`, D1 exports, access tokens, client secrets, or temporary uploads.
- Private mounts rely on ilist authorization; review Cloudflare logs, Access policies, and caching rules for your deployment.

## Upgrading From The Legacy R2 Index

The `objects` table and legacy object routes remain available for one compatibility release. Existing `/file/<old-key>` links resolve through the retained object index and redirect to stable entry URLs.

Before the first multi-mount deployment:

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-multi-mount.sql
npx wrangler d1 migrations apply ilist-db --remote
npm run migrate:objects -- --remote
npm run deploy
```

Do not remove the `objects` table or compatibility routes during the `v0.1.x` release line.

## Release Verification

Before publishing or upgrading a deployment:

```bash
npm ci
npm run check
curl -i 'https://YOUR_ILIST_ORIGIN/api/fs/list?path=/'
curl -i 'https://YOUR_ILIST_ORIGIN/api/admin/me'
```

The public root should return `200`. An unauthenticated `/api/admin/me` request should return `401` with `AUTH_REQUIRED`. Also verify a nested Unicode path and a disposable upload/download/delete cycle for each configured provider.

## Roadmap

- Resumable OneDrive uploads and multipart S3 uploads
- Per-path sharing and access policies
- Directory cache and provider-aware thumbnails
- Cross-mount copy jobs
- Additional storage drivers after the core interfaces stabilize

Contributions and issue reports should include the Worker version, storage provider, failing route, response code, and a sanitized error message. Never include provider tokens or Worker secrets.
