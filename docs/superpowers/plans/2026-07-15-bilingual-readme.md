# Bilingual README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long single-language repository landing document with concise, accurate English and Simplified Chinese README files that share one structure and support first-time Cloudflare deployment.

**Architecture:** `README.md` remains the canonical English landing page and links to a complete `README.zh.md` translation. Both documents keep essential setup commands inline and delegate detailed OneDrive registration to `docs/onedrive-setup.md`; content is verified against tracked configuration and scripts.

**Tech Stack:** Markdown, Cloudflare Workers, Workers Assets, D1, R2, Microsoft Graph, S3, TypeScript, React, Vite, Wrangler

## Global Constraints

- `README.md` is English; `README.zh.md` is Simplified Chinese; both link to each other at the top.
- Both files use the same section order, commands, tables, links, capability claims, warnings, and release number `v0.1.2`.
- Keep first-deployment commands inline and link detailed OneDrive registration to `docs/onedrive-setup.md`.
- Describe only implemented functionality; Google Drive, WebDAV, resumable uploads, multi-user permissions, and cross-mount copy remain limitations or roadmap items.
- Do not include credentials, deployment-specific resource IDs, private account data, or internal development history.

---

### Task 1: Rewrite the English landing document

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `package.json` scripts, `wrangler.jsonc` bindings and required secrets, `.dev.vars.example`, `docs/onedrive-setup.md`, and the implemented storage capability matrix.
- Produces: the canonical section order and exact commands that `README.zh.md` must mirror.

- [ ] **Step 1: Replace the opening with the bilingual project header**

Use a right-aligned `English | 简体中文` selector, centered `ilist` heading and product sentence, then factual shields for release `v0.1.2`, GPL-3.0, Cloudflare Workers, TypeScript, and tests. Link the release badge to `https://github.com/chius-me/ilist/releases/tag/v0.1.2` and the Chinese selector to `./README.zh.md`.

- [ ] **Step 2: Rebuild the overview sections**

Add these sections in order: `Features`, `Supported Storage`, and `Architecture`. Keep the existing four-row provider matrix, identify OneDrive as personal-account-only, and retain the native Worker architecture diagram with Workers Assets, D1, R2, Microsoft Graph, and S3.

- [ ] **Step 3: Convert Quick Start into numbered deployment steps**

Use the exact sequence below:

```text
1. Prerequisites
2. Clone and install
3. Create D1 and R2 resources
4. Configure wrangler.jsonc and apply D1 migrations
5. Generate the administrator password hash and random keys
6. Store all six required Worker secrets
7. Run npm run check and npm run deploy
8. Sign in as the ADMIN_USERNAME value, which defaults to admin
```

Keep these commands exact: `npm install`, `npx wrangler d1 create ilist-db`, `npx wrangler r2 bucket create ilist-files`, `npx wrangler d1 migrations apply ilist-db --remote`, `npm run hash-password`, `openssl rand -base64 32`, `openssl rand -hex 32`, `npm run check`, and `npm run deploy`.

- [ ] **Step 4: Add compact provider and operations guidance**

Add `Storage Setup`, `Local Development`, and `Commands`. Link OneDrive to `docs/onedrive-setup.md`; list the R2 S3 endpoint, `auto` region, path-style addressing, bucket name, access key ID, and secret access key. Keep the script table synchronized with `package.json`.

- [ ] **Step 5: Close with operational constraints**

Add concise `Security`, `Limitations`, `Legacy R2 Upgrade`, `Project Structure`, `Roadmap`, `Contributing`, and `License` sections. Keep the D1 backup warning, stable credential master-key warning, `v0.1.x` compatibility statement, and GPL-3.0-only wording.

- [ ] **Step 6: Review English claims against tracked files**

Run:

```bash
rg -n 'ADMIN_PASSWORD_HASH|CREDENTIAL_MASTER_KEY|SESSION_SECRET|MICROSOFT_CLIENT_ID|MICROSOFT_CLIENT_SECRET|PUBLIC_ORIGIN' README.md wrangler.jsonc .dev.vars.example
rg -n '^#{1,3} ' README.md
```

Expected: all six secrets are documented and headings follow the planned order.

### Task 2: Create the Simplified Chinese counterpart

**Files:**
- Create: `README.zh.md`

**Interfaces:**
- Consumes: the completed `README.md` structure, commands, links, tables, warnings, and capability statements.
- Produces: a complete Chinese document with semantic parity and a link back to `README.md`.

- [ ] **Step 1: Translate the header and overview**

Use `<a href="./README.md">English</a> | 简体中文` at the top. Preserve badge URLs and translate the product description, release scope, features, storage table labels, storage notes, and architecture explanation without changing capability claims.

- [ ] **Step 2: Translate deployment and provider guidance**

Mirror every Quick Start step, command block, secret name, URL, path, and provider field exactly. Translate prose and comments only. Link the detailed OneDrive guide to `docs/onedrive-setup.md`.

- [ ] **Step 3: Translate operational sections**

Mirror Local Development, Commands, Security, Limitations, Legacy R2 Upgrade, Project Structure, Roadmap, Contributing, and License in the same order. Preserve `GPL-3.0-only`, route names, script names, and release-line identifiers verbatim.

- [ ] **Step 4: Compare document structure**

Run:

```bash
rg '^#{1,3} ' README.md
rg '^#{1,3} ' README.zh.md
```

Expected: both outputs have the same number and order of heading levels, with translated titles.

### Task 3: Validate and commit the documentation

**Files:**
- Verify: `README.md`
- Verify: `README.zh.md`
- Verify: `docs/onedrive-setup.md`

**Interfaces:**
- Consumes: both completed README files.
- Produces: a link-valid, version-consistent documentation change ready for review.

- [ ] **Step 1: Verify local links and stale versions**

Run:

```bash
test -f README.zh.md
test -f docs/onedrive-setup.md
rg -n 'v0\.1\.1' README.md README.zh.md
git diff --check
```

Expected: both `test` commands succeed, the stale-version search returns no matches, and `git diff --check` exits successfully.

- [ ] **Step 2: Verify bilingual parity mechanically**

Compare the number of headings, fenced code blocks, table separators, and Markdown links in both files. Expected: equal counts for each category; investigate and correct every mismatch rather than suppressing it.

- [ ] **Step 3: Run the project validation suite**

Run:

```bash
npm run check
```

Expected: TypeScript check and production build pass; 177 Worker tests and 34 UI tests pass.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- README.md README.zh.md
```

Expected: only the planned README changes remain after the already committed design and plan documents.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md docs/superpowers/plans/2026-07-15-bilingual-readme.md
git commit -m "docs: add bilingual project readme"
```
