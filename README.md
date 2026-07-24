<div align="right"><a href="#ilist">English</a> | <a href="./README.zh.md">简体中文</a></div>

<div align="center">

# ilist

Self-hosted file index and manager for Cloudflare Workers.

[![Release](https://img.shields.io/badge/release-v0.1.7-2ea44f?logo=github)](https://github.com/chius-me/ilist/releases/tag/v0.1.7)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/chius-me/ilist/blob/main/LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Vitest-6e9f18)

</div>

> [v0.1.7](https://github.com/chius-me/ilist/releases/tag/v0.1.7) hardens same-origin file delivery, share-root checks, password authentication, and mount publication defaults. Read the [release guide](docs/releases/v0.1.7.md) before upgrading.

## Features

- Virtual root with multiple independently named storage mounts
- OneDrive Personal OAuth authorization with PKCE and encrypted refresh tokens
- Multiple OneDrive accounts, each mounted at a custom top-level path
- Multiple Google My Drive accounts or roots, each independently authorized and mounted at a custom top-level path
- S3-compatible mounts with AWS Signature Version 4
- Cloudflare R2 through either S3 credentials or the built-in Worker binding
- Public directory browsing, stable file links, downloads, and common file previews
- Revocable file and folder shares with optional passwords, expiration, and download policy
- English and Simplified Chinese interface with system, light, and dark themes stored locally
- List and grid views, breadcrumbs, sorting, search, keyboard selection, and responsive layout
- Responsive storage and appearance administration for desktop, tablet, and mobile screens
- Administrator login, upload, folder creation, rename, move, delete, and visibility controls
- Resumable OneDrive uploads and multipart S3 uploads with pause, resume, retry, cancel, and progress controls
- D1 migrations and compatibility support for legacy R2 object links
- Streamed provider responses without buffering complete files in Worker memory

## Supported Storage

| Storage | Browse | Download | Upload | Manage | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| OneDrive Personal | ✓ | ✓ | ✓ | ✓ | Resumable upload; personal Microsoft accounts only |
| Google My Drive | ✓ | ✓ | ✓ | ✓ | Range downloads, resumable upload, and Docs/Sheets/Slides export |
| Cloudflare R2 binding | ✓ | ✓ | ✓ | ✓ | Built-in compatibility mount; single-request upload only |
| Cloudflare R2 through S3 | ✓ | ✓ | ✓ | ✓ | Multipart upload with the R2 S3 endpoint and scoped credentials |
| Other S3-compatible storage | ✓ | ✓ | ✓ | ✓ | Multipart compatibility depends on the provider's S3 implementation |

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
        +-- Google Drive driver -> Google Drive API v3
        +-- S3 driver -> R2 or another S3-compatible provider
        +-- D1 -> mounts, encrypted credentials, entries, sessions, shares
        +-- R2 binding -> built-in compatibility storage
```

The Worker acts as the control plane and streams or redirects file data where possible. Provider credentials are encrypted before they are written to D1.

## Quick Start

1. **Prerequisites.** Install Node.js 22.12 or newer and npm 10 or newer. Have a Cloudflare account with Workers, D1, and R2 enabled, Wrangler authenticated with `npx wrangler login`, a Microsoft Entra application for OneDrive Personal, and a Google Cloud OAuth application for Google Drive.
2. **Clone and install.**

   ```bash
   git clone https://github.com/chius-me/ilist.git
   cd ilist
   npm install
   ```

3. **Create D1 and R2 resources.**

   ```bash
   npx wrangler d1 create ilist-db
   npx wrangler r2 bucket create ilist-files
   ```

4. **Configure `wrangler.jsonc`, the custom domain, and D1 migrations.** Copy the D1 `database_id` returned by Wrangler into `wrangler.jsonc`, confirm the database and bucket names, and keep the configured `ilist.chius.cc` custom-domain route only when that hostname is in your Cloudflare zone. Then run:

   ```bash
   npx wrangler d1 migrations apply ilist-db --remote
   ```

5. **Generate the administrator password hash and random keys.**

   ```bash
   npm run hash-password   # ADMIN_PASSWORD_HASH; enter the password at the prompt
   openssl rand -base64 32 # CREDENTIAL_MASTER_KEY
   openssl rand -hex 32    # SESSION_SECRET
   ```

   The password command rejects password arguments. On a terminal it disables character echo while reading the prompt. Automation may provide exactly one password line through non-TTY standard input; stdout contains only the generated hash, while prompts and errors use stderr.

   New hashes use `pbkdf2-sha256:600000`. Legacy `pbkdf2` hashes remain valid for this release, but an administrator hash is a Cloudflare Secret and cannot be upgraded automatically. After a successful legacy login, rotate it with these exact commands:

   ```bash
   npm run hash-password
   npx wrangler secret put ADMIN_PASSWORD_HASH
   ```

6. **Store all eight required Worker secrets.** Use the generated values and the provider application values with `npx wrangler secret put`:

   ```bash
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put CREDENTIAL_MASTER_KEY
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put MICROSOFT_CLIENT_ID
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put PUBLIC_ORIGIN
   ```

   The canonical production value is `https://ilist.chius.cc`. `PUBLIC_ORIGIN` must exactly match the deployed HTTPS origin and have no trailing slash.

7. **Run `npm run check` and `npm run deploy`.**

   ```bash
   npm run check
   npm run deploy
   ```

8. **Sign in as the `ADMIN_USERNAME` value, which defaults to `admin`.** The password is the plaintext value used to generate `ADMIN_PASSWORD_HASH`.

## Storage Setup

Open `/admin/storages` after signing in. Each mount has its own display name, top-level mount path, provider and encrypted credentials, public or private visibility, enabled state, and optional provider root. Deleting or disconnecting a mount removes only ilist configuration and credentials; it does not delete the provider account, bucket, drive, or stored objects.

For OneDrive Personal, follow [docs/onedrive-setup.md](docs/onedrive-setup.md). Use a Microsoft Entra application configured for personal Microsoft accounts only, with the Web redirect URI `https://ilist.chius.cc/api/admin/oauth/onedrive/callback` and delegated Graph permissions `User.Read` and `Files.ReadWrite`. Retain the existing `https://ilist.chius.workers.dev/api/admin/oauth/onedrive/callback` URI until the custom-domain authorization flow is verified.

For Google Drive, follow [docs/google-drive-setup.md](docs/google-drive-setup.md). Enable Google Drive API, create a Web OAuth client with redirect URI `https://ilist.chius.cc/api/admin/oauth/google/callback`, and configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Retain the existing `https://ilist.chius.workers.dev/api/admin/oauth/google/callback` URI until the custom-domain authorization flow is verified. ilist requests `https://www.googleapis.com/auth/drive`; keep a development consent screen in testing with explicit test users, or complete Google's production verification requirements before serving other users.

For Cloudflare R2 through S3, use:

```text
Endpoint: https://ACCOUNT_ID.r2.cloudflarestorage.com
Region: auto
Addressing mode: path style
Bucket name: ilist-files
Access key ID: R2 API token access key ID
Secret access key: R2 API token secret access key
```

Use a bucket-scoped R2 API token with only the permissions ilist requires.

## Upload Behavior

- Files smaller than `10 MiB` use the existing single-request upload path.
- Files of exactly `10 MiB` or larger use resumable upload when the current OneDrive, Google Drive, or S3 mount advertises multipart support.
- Parts are uploaded sequentially in `10 MiB` chunks. The queue runs at most two files concurrently.
- Pause, resume, and retry preserve the opaque ilist upload session and server-confirmed parts while the page remains open. Reloading or leaving the page discards the in-memory queue; unfinished server sessions are later cleaned up, but automatic recovery after reload is not implemented.
- Provider upload URLs, OneDrive session proofs, Google resumable session URLs, and S3 upload IDs remain encrypted or server-side and are never returned to the browser.
- The built-in `R2` Worker binding remains compatible with existing deployments but does not implement resumable upload; use an S3-configured R2 mount for multipart uploads.
- Configure an incomplete multipart upload lifecycle rule on S3-compatible buckets so abandoned provider uploads are removed if Worker cleanup cannot reach them.

OneDrive resumable upload uses the same delegated `Files.ReadWrite` permission documented above. Google Drive uses the full Drive OAuth scope documented above. Apply all D1 migrations, including `0012_upload_sessions.sql`, `0013_upload_terminal_leases.sql`, `0014_shares.sql`, `0015_auth_rate_limits.sql`, and `0016_mounts_private_default.sql`, before deploying v0.1.7.

## Controlled Shares

Administrators can create a share from any file or folder action menu and manage existing shares at `/admin/shares`. A share may require a password, expire at a chosen time, block explicit downloads, or be disabled and re-enabled. Folder shares support nested browsing, list and grid views, and the same safe preview types as the main explorer.

Google Docs, Sheets, and Slides expose explicit export formats in both the main explorer and controlled shares. PDF is used for preview when available; downloads remain subject to the share's current download policy.

The raw `/s/:token` URL is returned only once when the share is created. D1 stores only its SHA-256 hash, so the management page cannot recover or copy an existing link. Public item IDs are share-scoped encrypted handles rather than mount or provider IDs. Password authorization uses a short-lived, `HttpOnly`, `SameSite=Lax` cookie scoped to that share path.

Every metadata, listing, preview, and file request rechecks the current password, enabled, expiration, target, and download policy. Share responses use `Cache-Control: private, no-store`; do not add a Cloudflare cache rule that overrides this policy. Disabling or deleting a share therefore takes effect on the next request.

Public share routes are rooted at `/s/:token`. Administrator automation may use `GET`, `POST`, `PATCH`, and `DELETE` under `/api/admin/shares`, subject to the normal administrator session and same-origin protections.

## Local Development

Create local secrets from the tracked template:

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply ilist-db --local
npm run dev
```

Fill in test-only values before starting Wrangler. It normally serves the application at `http://localhost:8787`. OAuth cannot complete against that plain-HTTP origin; use a deployed Worker or an HTTPS development hostname for the callback flow. Local D1 and R2 data are isolated from production. Never put production credentials in `.dev.vars`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the local Worker and UI |
| `npm run dev:web` | Run the frontend-only Vite development server |
| `npm run build` | Build the Vite frontend |
| `npm run test:worker` | Run Worker runtime tests |
| `npm run test:ui` | Run UI tests |
| `npm run test:e2e` | Run browser workflows in desktop, tablet, and mobile viewports |
| `npm run test:visual` | Run browser screenshot scenarios |
| `npm run test` | Run all tests |
| `npm run check` | Type-check, build, and run all tests |
| `npm run deploy` | Build and deploy with Wrangler |
| `npm run hash-password` | Prompt for and generate an administrator password hash |
| `npm run migrate:objects -- --local` | Import legacy object rows into the entry model locally |
| `npm run migrate:objects -- --remote` | Import legacy object rows in production |

## Continuous Deployment

[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) runs `npm run check` on every pull request and every push to `main`.

After a green check on `main` (or on manual `workflow_dispatch`), the same workflow applies pending remote D1 migrations, then deploys the Worker and Assets with Wrangler. Worker secrets set with `wrangler secret put` stay in Cloudflare and are not re-uploaded by CI.

Configure these **repository secrets** (Settings → Secrets and variables → Actions) before the first automated deploy:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with permission to edit Workers, Workers Routes / Custom Domains, and D1 for this account |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID that owns the `ilist` Worker, `ilist-db` D1 database, and `ilist-files` R2 bucket |

Do not put `ADMIN_PASSWORD_HASH`, `CREDENTIAL_MASTER_KEY`, OAuth client secrets, or other Worker secrets into GitHub. Keep them only as Cloudflare Worker secrets.

## Security

- Keep `CREDENTIAL_MASTER_KEY` stable. Changing it without a re-encryption migration makes stored provider credentials unreadable.
- Rotate any credential that has appeared in a terminal recording, screenshot, issue, or chat.
- Back up D1 before applying migrations or deploying a new release.
- Use least-privilege, bucket-scoped S3 or R2 credentials.
- Do not commit `.dev.vars`, D1 exports, access tokens, client secrets, or temporary uploads.
- Private mounts rely on ilist authorization; review Cloudflare logs, Access policies, and caching rules for your deployment.
- Share links are bearer credentials. Send them through an appropriate private channel and add a password for sensitive targets.
- Existing share URLs cannot be recovered from D1; create a replacement share if the original URL is lost.
- Same-origin HTML, SVG, XML, PDF, and unknown file types are sent as attachments with a sandboxed file response policy. Only a narrow, exact image/audio/video MIME allowlist is previewed inline.
- New mounts are private by default. Publishing a mount requires explicit administrator confirmation because unauthenticated visitors can browse it.
- Share item handles are checked against the live share root on every access. Moving an item outside the shared folder revokes its old handle immediately.
- Failed administrator attempts are limited before PBKDF2 by both a five-per-minute IP-wide budget and a five-per-minute IP-plus-normalized-username budget. Share-password attempts remain limited to ten per minute per IP and share. Do not put a caching rule in front of share responses.
- OneDrive and Google Drive share ancestry is checked live, but a provider-side move concurrent with a metadata or download request leaves a narrow unavoidable TOCTOU window. Restrict provider write access for sensitive public shares and disable a share when immediate revocation is required.

## Limitations

- Single administrator; no registration or multi-user permission model
- OneDrive Personal only; work and school tenants are not yet supported
- Google support is limited to My Drive. Shared Drives, Shared with me, and shortcut traversal are not implemented.
- No WebDAV, FTP, SFTP, SMB, or local filesystem drivers
- Resumable recovery is page-session-only; reloading the page does not restore the upload queue
- Built-in R2 binding uploads remain single-request and subject to Cloudflare request-body limits
- No cross-mount copy or move
- Shares do not support uploads, recipient accounts, access quotas, or access counters
- No offline download, archive extraction, media transcoding, or background task system
- Provider listings are fetched live; distributed directory caching is not implemented
- Built-in R2 recursive deletion is bounded and reports per-entry failures; S3-compatible and OneDrive folder deletion follow provider-specific behavior

## Legacy R2 Upgrade

Before changing production, export D1 and keep the export outside Git:

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-multi-mount.sql
npx wrangler d1 migrations apply ilist-db --remote
npm run migrate:objects -- --remote
npm run deploy
```

The `v0.1.x` releases are intended to remain compatible with legacy R2 object links. Migrations add the entry and mount model without deleting files or legacy rows. For the v0.1.7 security release, follow [the release abort procedure](docs/releases/v0.1.7.md#emergency-abort-and-rollback): do not return public traffic to v0.1.6, and retain `0015` and `0016`. Restore a D1 export only when data itself is damaged or a migration failed.

## Project Structure

```text
src/
  ui/                         React file explorer and admin UI
  worker/
    index.ts                  Native Worker entry point
    router.ts                 HTTP route dispatch
    file-system.ts            Virtual filesystem operations
    drivers/
      onedrive/               Microsoft Graph driver and OAuth tokens
      google/                 Google Drive API driver and OAuth tokens
      s3/                     S3-compatible driver and SigV4 client
migrations/                   D1 schema migrations
tests/worker/                 Worker runtime tests
tests/ui/                     React component and interaction tests
docs/                         Setup and implementation documentation
```

## Roadmap

- Work and school Microsoft accounts
- Google Shared Drives and shortcuts
- Cross-mount copy and move
- Additional storage drivers and background operations

## Contributing

Run `npm run check` before submitting a change. Keep provider credentials, local variables, D1 exports, and temporary uploads out of Git. Update the relevant documentation when changing storage behavior or deployment requirements.

## License

ilist is licensed under the GPL-3.0-only license.
