<div align="right"><a href="#ilist">English</a> | <a href="./README.zh.md">简体中文</a></div>

<div align="center">

# ilist

Self-hosted file index and manager for Cloudflare Workers.

[![Release](https://img.shields.io/badge/release-v0.1.3-2ea44f?logo=github)](https://github.com/chius-me/ilist/releases/tag/v0.1.3)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/chius-me/ilist/blob/main/LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Vitest-6e9f18)

</div>

> [v0.1.3](https://github.com/chius-me/ilist/releases/tag/v0.1.3) targets one administrator with public read-only browsing. Review [Limitations](#limitations) and back up D1 before upgrading.

## Features

- Virtual root with multiple independently named storage mounts
- OneDrive Personal OAuth authorization with PKCE and encrypted refresh tokens
- Multiple OneDrive accounts, each mounted at a custom top-level path
- S3-compatible mounts with AWS Signature Version 4
- Cloudflare R2 through either S3 credentials or the built-in Worker binding
- Public directory browsing, stable file links, downloads, and common file previews
- English and Simplified Chinese interface with system, light, and dark themes stored locally
- List and grid views, breadcrumbs, sorting, search, keyboard selection, and responsive layout
- Responsive storage and appearance administration for desktop, tablet, and mobile screens
- Administrator login, upload, folder creation, rename, move, delete, and visibility controls
- D1 migrations and compatibility support for legacy R2 object links
- Streamed provider responses without buffering complete files in Worker memory

## Supported Storage

| Storage | Browse | Download | Upload | Manage | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| OneDrive Personal | ✓ | ✓ | ✓ | ✓ | Personal Microsoft accounts only |
| Cloudflare R2 binding | ✓ | ✓ | ✓ | ✓ | Built-in `R2` compatibility mount |
| Cloudflare R2 through S3 | ✓ | ✓ | ✓ | ✓ | Use the R2 S3 endpoint and scoped credentials |
| Other S3-compatible storage | ✓ | ✓ | ✓ | ✓ | Compatibility depends on the provider's S3 implementation |

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

## Quick Start

1. **Prerequisites.** Install Node.js 22.12 or newer and npm 10 or newer. Have a Cloudflare account with Workers, D1, and R2 enabled, Wrangler authenticated with `npx wrangler login`, and a Microsoft Entra application if you will use OneDrive Personal.
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

4. **Configure `wrangler.jsonc` and apply D1 migrations.** Copy the D1 `database_id` returned by Wrangler into `wrangler.jsonc`, confirm the database and bucket names, then run:

   ```bash
   npx wrangler d1 migrations apply ilist-db --remote
   ```

5. **Generate the administrator password hash and random keys.**

   ```bash
   npm run hash-password -- "choose-a-strong-password" # ADMIN_PASSWORD_HASH
   openssl rand -base64 32                              # CREDENTIAL_MASTER_KEY
   openssl rand -hex 32                                 # SESSION_SECRET
   ```

6. **Store all six required Worker secrets.** Use the generated values and the Microsoft application values with `npx wrangler secret put`:

   ```bash
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put CREDENTIAL_MASTER_KEY
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put MICROSOFT_CLIENT_ID
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   npx wrangler secret put PUBLIC_ORIGIN
   ```

   `PUBLIC_ORIGIN` must be the exact deployed HTTPS origin without a trailing slash, for example `https://ilist.example.com`.

7. **Run `npm run check` and `npm run deploy`.**

   ```bash
   npm run check
   npm run deploy
   ```

8. **Sign in as the `ADMIN_USERNAME` value, which defaults to `admin`.** The password is the plaintext value used to generate `ADMIN_PASSWORD_HASH`.

## Storage Setup

Open `/admin/storages` after signing in. Each mount has its own display name, top-level mount path, provider and encrypted credentials, public or private visibility, enabled state, and optional provider root. Deleting or disconnecting a mount removes only ilist configuration and credentials; it does not delete the provider account, bucket, drive, or stored objects.

For OneDrive Personal, follow [docs/onedrive-setup.md](docs/onedrive-setup.md). Use a Microsoft Entra application configured for personal Microsoft accounts only, with the Web redirect URI `https://YOUR_ILIST_ORIGIN/api/admin/oauth/onedrive/callback` and delegated Graph permissions `User.Read` and `Files.ReadWrite`.

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
| `npm run hash-password -- "..."` | Generate an administrator password hash |
| `npm run migrate:objects -- --local` | Import legacy object rows into the entry model locally |
| `npm run migrate:objects -- --remote` | Import legacy object rows in production |

## Security

- Keep `CREDENTIAL_MASTER_KEY` stable. Changing it without a re-encryption migration makes stored provider credentials unreadable.
- Rotate any credential that has appeared in a terminal recording, screenshot, issue, or chat.
- Back up D1 before applying migrations or deploying a new release.
- Use least-privilege, bucket-scoped S3 or R2 credentials.
- Do not commit `.dev.vars`, D1 exports, access tokens, client secrets, or temporary uploads.
- Private mounts rely on ilist authorization; review Cloudflare logs, Access policies, and caching rules for your deployment.

## Limitations

- Single administrator; no registration or multi-user permission model
- OneDrive Personal only; work and school tenants are not yet supported
- No Google Drive, WebDAV, FTP, SFTP, SMB, or local filesystem drivers
- Uploads use one non-resumable Worker request and are subject to Cloudflare request-body limits
- No multipart S3 upload or OneDrive upload session yet
- No cross-mount copy or move
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

The `v0.1.x` releases are intended to remain compatible with legacy R2 object links. Migrations add the entry and mount model without deleting files or legacy rows. If deployment fails, deploy the previous Worker version and keep the additive migrations in place; restore the D1 export only when data itself is damaged, not merely to roll back Worker code.

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
      s3/                     S3-compatible driver and SigV4 client
migrations/                   D1 schema migrations
tests/worker/                 Worker runtime tests
tests/ui/                     React component and interaction tests
docs/                         Setup and implementation documentation
```

## Roadmap

- Work and school Microsoft accounts
- Resumable and multipart uploads
- Cross-mount copy and move
- Additional storage drivers and background operations

## Contributing

Run `npm run check` before submitting a change. Keep provider credentials, local variables, D1 exports, and temporary uploads out of Git. Update the relevant documentation when changing storage behavior or deployment requirements.

## License

ilist is licensed under the GPL-3.0-only license.
