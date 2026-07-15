# ilist Bilingual README Design

## Goal

Make the repository landing page easier to scan and deploy from while preserving accurate operational guidance. Follow the presentation pattern used by `chius-me/qbittorrent-bot`: English as the default README, a complete Simplified Chinese counterpart, and a language switch at the top of both files.

## Files

- `README.md`: canonical English landing document.
- `README.zh.md`: complete Simplified Chinese counterpart.
- `docs/onedrive-setup.md`: remains the detailed OneDrive registration and troubleshooting guide.

The two README files must have matching section order, commands, capability claims, warnings, and links. Translation may adapt phrasing but must not change meaning.

## Information Architecture

1. Language switch, centered project name, one-sentence product description, and factual badges.
2. Current release scope and a link to the latest release.
3. Feature highlights focused on the virtual filesystem, mount management, supported providers, file operations, previews, and Cloudflare-native deployment.
4. Storage capability matrix for OneDrive Personal, built-in R2, R2 through S3, and generic S3-compatible providers.
5. Compact architecture diagram explaining Workers Assets, the native Worker router, D1, R2, Microsoft Graph, and S3.
6. Numbered quick start covering prerequisites, Cloudflare resources, migrations, secrets, deployment, and initial sign-in.
7. Short provider setup sections linking to detailed OneDrive documentation and listing the required R2/S3 fields.
8. Local development and command reference.
9. Security and current limitations, kept visible but concise.
10. Project structure, roadmap, contribution guidance, and GPL-3.0 license.

## Content Boundaries

- Keep commands that a first-time deployer must run directly in the README.
- Move procedural depth and troubleshooting to `docs/`; do not duplicate the full OneDrive guide.
- Keep legacy R2 migration instructions discoverable through a concise upgrade section because `v0.1.x` still supports old links.
- Describe only implemented and tested functionality. Google Drive, resumable uploads, multi-user permissions, WebDAV, and cross-mount copy remain limitations or roadmap items.
- Do not publish credentials, deployment-specific IDs, private account details, or internal development history.

## Presentation

- Use the restrained centered header and language selector from the reference repository.
- Use shields for release, license, Cloudflare Workers, TypeScript, and test status only when the badge target is stable and factual.
- Prefer tables for provider support and commands, short lists for features and limitations, and fenced blocks for executable commands.
- Keep decorative emoji limited to the feature heading so the document remains technical and readable.

## Validation

- Verify all relative links and referenced files exist.
- Verify every command and environment name against `package.json`, `wrangler.jsonc`, `.dev.vars.example`, and current routes.
- Compare English and Chinese headings, tables, code blocks, and links for parity.
- Run `npm run check` to ensure documentation edits do not accompany an unnoticed project regression.
- Run `git diff --check` and scan for stale `v0.1.1` references.
