# ilist Core File Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current R2 object dashboard with one OpenList-style file explorer where guests browse and preview public entries and an authenticated administrator performs core file management in place.

**Architecture:** D1 becomes the source of truth for a stable-ID virtual filesystem, while R2 stores immutable blobs addressed by `storage_key`. The native Worker exposes one read API with optional session-aware capabilities plus authenticated mutation APIs; the React app uses URL-driven navigation, focused hooks, and small feature components rather than separate public/admin pages.

**Tech Stack:** Cloudflare native Worker, TypeScript, D1, R2, Workers Assets, React 19, Vite 7, Vitest, `@cloudflare/vitest-pool-workers`, Testing Library, jsdom.

## Global Constraints

- Keep the native `fetch(request, env)` Worker entrypoint; do not add Hono.
- Keep React and Vite; do not migrate frameworks or add a global state library.
- Do not add a frontend router; navigation is implemented with pathname, query parameters, and `popstate`.
- Guests and administrators use the same explorer; authentication only changes returned entries and capabilities.
- Use D1 parent/child entries for virtual paths and immutable R2 `storage_key` values for file contents.
- Reserve root path names `api`, `file`, and `admin`.
- Keep old `objects` data and `/file/*key` links compatible for at least one release.
- Do not include visual brand redesign, batch archive downloads, multipart upload, external storage drivers, sharing records, WebDAV, or multi-user permissions.
- All large file bodies must remain streamed; never call `arrayBuffer()` on a full object.
- Every task must leave `npm run check` or its explicitly narrower test command passing before commit.

---

## Final File Map

### Worker and data

- `migrations/0002_entries.sql`: creates the virtual filesystem schema and root entry.
- `src/worker/types.ts`: D1 row, API entry, capability, batch result, and environment types.
- `src/worker/entry-domain.ts`: path decoding, name validation, and storage-key helpers.
- `src/worker/db.ts`: low-level entry queries and D1 batch operations.
- `src/worker/entries.ts`: path resolution, breadcrumbs, visibility, and API mapping.
- `src/worker/file-system.ts`: create, patch, move, visibility, upload lifecycle, and deletion orchestration.
- `src/worker/r2.ts`: immutable blob put/get/delete and Range/conditional response handling.
- `src/worker/http.ts`: structured errors and same-origin validation.
- `src/worker/router.ts`: new API routing and old-route compatibility.
- `scripts/lib/legacy-entries.mjs`: deterministic conversion of old object rows.
- `scripts/migrate-objects.mjs`: idempotent local/remote migration command.

### React application

- `src/ui/app/ExplorerApp.tsx`: the single application shell.
- `src/ui/api/client.ts`: envelope parsing and typed API errors.
- `src/ui/api/entries.ts`: list/detail/mutation requests and stable URLs.
- `src/ui/api/session.ts`: login, logout, and current-user requests.
- `src/ui/api/uploads.ts`: XHR upload transport.
- `src/ui/hooks/useExplorerLocation.ts`: pathname and preview query state.
- `src/ui/hooks/useDirectory.ts`: cancellable folder loading and refresh.
- `src/ui/hooks/useSelection.ts`: entry-ID selection state.
- `src/ui/hooks/useSession.ts`: guest/admin session state.
- `src/ui/features/explorer/*`: breadcrumbs, toolbar, list, grid, rows, selection toolbar, and menus.
- `src/ui/features/preview/*`: preview type selection and overlay.
- `src/ui/features/operations/*`: rename, move, delete, and properties dialogs.
- `src/ui/features/uploads/*`: queue reducer, hook, panel, and task rows.
- `src/ui/types/entries.ts`: shared browser-facing types.
- `src/ui/styles.css`: functional classic layout and responsive states; no brand-polish pass.

### Tests and configuration

- `vitest.worker.config.ts`: Workers runtime test project.
- `vitest.ui.config.ts`: jsdom React test project.
- `tests/worker/setup.ts`: D1 schema setup.
- `tests/worker/*.test.ts`: domain, repository, API, R2, mutation, migration, and compatibility tests.
- `tests/ui/setup.ts`: DOM test setup.
- `tests/ui/*.test.tsx`: navigation, explorer, preview, operations, and upload tests.
- `tests/scripts/*.test.ts`: Node-runtime tests for the legacy migration command.
- `tests/sql.d.ts`: raw SQL import declaration.

---

### Task 0: Establish a Tracked V1 Baseline

**Files:**
- Modify: `.gitignore`
- Track without behavioral changes: `.dev.vars.example`, `README.md`, `index.html`, `migrations/0001_initial.sql`, `package.json`, `package-lock.json`, `scripts/hash-password.mjs`, `src/`, `tsconfig.json`, `vite.config.ts`, `wrangler.jsonc`

**Interfaces:**
- Consumes: the currently deployed V1 worktree.
- Produces: a reviewable baseline commit so later tasks contain only intentional diffs.

- [ ] **Step 1: Ignore visual-companion artifacts**

Add this line to `.gitignore`:

```gitignore
.superpowers/
```

- [ ] **Step 2: Verify the untouched V1 baseline**

Run:

```bash
npm run check
```

Expected: TypeScript and Vite build complete successfully.

- [ ] **Step 3: Confirm generated and secret files are excluded**

Run:

```bash
git status --short --ignored
```

Expected: `.dev.vars`, `dist/`, `.wrangler/`, `node_modules/`, and `.superpowers/` appear only as ignored entries; no secret file is staged.

- [ ] **Step 4: Commit the existing application baseline**

```bash
git add .dev.vars.example .gitignore README.md index.html migrations/0001_initial.sql package.json package-lock.json scripts/hash-password.mjs src tsconfig.json vite.config.ts wrangler.jsonc
git commit -m "chore: track ilist v1 baseline"
```

Expected: only the existing application and `.gitignore` are committed; the design and plan commits remain separate.

---

### Task 1: Add Test Projects and Structured HTTP Errors

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `src/worker/http.ts`
- Create: `vitest.worker.config.ts`
- Create: `vitest.ui.config.ts`
- Create: `tests/worker/http.test.ts`
- Create: `tests/ui/setup.ts`
- Create: `tests/sql.d.ts`

**Interfaces:**
- Consumes: existing `HttpError`, `fail()`, and npm scripts.
- Produces: `HttpError(status, code, message, details?)`, `fail(status, code, message, details?)`, `requireSameOrigin(request)`, `npm run test:worker`, and `npm run test:ui`.

- [ ] **Step 1: Install the test dependencies**

Run:

```bash
npm install --save-dev vitest @cloudflare/vitest-pool-workers @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

Expected: `package.json` and `package-lock.json` add only development dependencies.

- [ ] **Step 2: Configure separate Worker and UI test projects**

Create `vitest.worker.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/worker/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ADMIN_USERNAME: 'admin',
            ADMIN_PASSWORD_HASH:
              'pbkdf2:100000:59f4c454ba32d9dd29cfb537108c4d0b:c5685e17dd3356159b581df88e6580d8db0379a2dc27479d24862bf6f88b7df7',
            SESSION_SECRET: 'test-session-secret-at-least-32-characters',
            SESSION_TTL_SECONDS: '3600',
          },
        },
      },
    },
  },
});
```

Create `vitest.ui.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/ui/**/*.test.ts', 'tests/ui/**/*.test.tsx', 'tests/scripts/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./tests/ui/setup.ts'],
  },
});
```

Create `tests/ui/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

Create `tests/sql.d.ts`:

```ts
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
```

Update `package.json` scripts to include:

```json
{
  "test": "npm run test:worker && npm run test:ui",
  "test:worker": "vitest run --config vitest.worker.config.ts",
  "test:ui": "vitest run --config vitest.ui.config.ts",
  "check": "tsc --noEmit && npm run build && npm run test"
}
```

Add the two config files and `tests` to `tsconfig.json` `include`.

- [ ] **Step 3: Write the failing structured-error tests**

Create `tests/worker/http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fail, HttpError, requireSameOrigin } from '../../src/worker/http';

describe('HTTP errors', () => {
  it('serializes a stable error code and details', async () => {
    const response = fail(409, 'ENTRY_NAME_CONFLICT', 'Name already exists', { name: 'readme.md' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'ENTRY_NAME_CONFLICT',
        message: 'Name already exists',
        details: { name: 'readme.md' },
      },
    });
  });

  it('stores status, code, message, and details on HttpError', () => {
    const error = new HttpError(400, 'INVALID_ENTRY_NAME', 'Invalid name', { reason: 'slash' });
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_ENTRY_NAME',
      message: 'Invalid name',
      details: { reason: 'slash' },
    });
  });

  it('rejects a cross-origin mutation', () => {
    const request = new Request('https://ilist.example/api/admin/folders', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    expect(() => requireSameOrigin(request)).toThrowError(HttpError);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
npm run test:worker -- tests/worker/http.test.ts
```

Expected: FAIL because the current error envelope has no `code` and `requireSameOrigin` does not exist.

- [ ] **Step 5: Implement the error contract without breaking existing callers**

Replace the error-specific parts of `src/worker/http.ts` with:

```ts
export class HttpError extends Error {
  public readonly code: string;
  public readonly details: unknown;

  constructor(
    public readonly status: number,
    codeOrMessage: string,
    message?: string,
    details?: unknown,
  ) {
    const legacyCall = message === undefined;
    super(legacyCall ? codeOrMessage : message);
    this.name = 'HttpError';
    this.code = legacyCall ? `HTTP_${status}` : codeOrMessage;
    this.details = details;
  }
}

export function fail(status: number, codeOrMessage: string, message?: string, details?: unknown): Response {
  const legacyCall = message === undefined;
  return json(
    {
      ok: false,
      error: {
        code: legacyCall ? `HTTP_${status}` : codeOrMessage,
        message: legacyCall ? codeOrMessage : message,
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}

export function requireSameOrigin(request: Request): void {
  const expected = new URL(request.url).origin;
  const actual = request.headers.get('origin');
  if (actual !== expected) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }
}
```

Keep `json`, `ok`, `readJson`, `notFound`, and `noContent`; existing two-argument `HttpError` and `fail` calls remain valid because their second argument becomes the displayed message and receives a generic `HTTP_<status>` code.

- [ ] **Step 6: Run checks and commit**

Run:

```bash
npm run test:worker -- tests/worker/http.test.ts
npm run check
```

Expected: all tests and build pass.

```bash
git add package.json package-lock.json tsconfig.json vitest.worker.config.ts vitest.ui.config.ts tests src/worker/http.ts
git commit -m "test: add worker and ui test harnesses"
```

---

### Task 2: Create the Entry Schema and Domain Rules

**Files:**
- Create: `migrations/0002_entries.sql`
- Create: `src/worker/entry-domain.ts`
- Modify: `src/worker/types.ts`
- Create: `tests/worker/entry-domain.test.ts`
- Create: `tests/worker/setup.ts`

**Interfaces:**
- Consumes: D1 `objects` schema and structured errors from Task 1.
- Produces: `EntryRow`, `Entry`, `EntryCapabilities`, `normalizeVirtualPath()`, `validateEntryName()`, `storageKeyForEntry()`, and a fixed root entry ID `root`.

- [ ] **Step 1: Write the failing domain tests**

Create `tests/worker/entry-domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  normalizeVirtualPath,
  storageKeyForEntry,
  validateEntryName,
} from '../../src/worker/entry-domain';

describe('entry domain', () => {
  it('decodes Chinese path segments independently', () => {
    expect(normalizeVirtualPath('/R2/%E9%A1%B9%E7%9B%AE/demo')).toEqual({
      path: '/R2/项目/demo',
      segments: ['R2', '项目', 'demo'],
    });
  });

  it.each(['', '.', '..', 'a/b', 'bad\u0000name'])('rejects invalid name %j', (name) => {
    expect(() => validateEntryName(name)).toThrow();
  });

  it('rejects reserved root names only at the root', () => {
    expect(() => validateEntryName('api', true)).toThrow();
    expect(validateEntryName('api', false)).toBe('api');
  });

  it('uses an immutable physical key', () => {
    expect(storageKeyForEntry('018f-entry')).toBe('blobs/018f-entry');
  });
});
```

- [ ] **Step 2: Run the domain tests to verify they fail**

```bash
npm run test:worker -- tests/worker/entry-domain.test.ts
```

Expected: FAIL because `entry-domain.ts` does not exist.

- [ ] **Step 3: Add the D1 schema**

Create `migrations/0002_entries.sql` with the exact schema from the approved design:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  storage_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'deleting')),
  is_public INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'file' AND storage_key IS NOT NULL) OR
    (kind = 'folder' AND storage_key IS NULL)
  ),
  UNIQUE (parent_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS entries_storage_key_unique
ON entries(storage_key)
WHERE storage_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS entries_parent_order
ON entries(parent_id, sort_order, name);

INSERT OR IGNORE INTO entries (
  id, parent_id, name, kind, storage_key, size, content_type, etag,
  status, is_public, sort_order, description, created_at, updated_at
) VALUES (
  'root', NULL, '', 'folder', NULL, 0, NULL, NULL,
  'ready', 1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
```

Create `tests/worker/setup.ts`:

```ts
import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import initial from '../../migrations/0001_initial.sql?raw';
import entries from '../../migrations/0002_entries.sql?raw';

beforeEach(async () => {
  await env.DB.exec(initial);
  await env.DB.exec(entries);
});
```

Add `setupFiles: ['./tests/worker/setup.ts']` to `vitest.worker.config.ts`.

- [ ] **Step 4: Define the stable entry types**

Add to `src/worker/types.ts`:

```ts
export type EntryKind = 'file' | 'folder';
export type EntryStatus = 'uploading' | 'ready' | 'deleting';

export interface EntryRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: EntryKind;
  storage_key: string | null;
  size: number;
  content_type: string | null;
  etag: string | null;
  status: EntryStatus;
  is_public: number;
  sort_order: number;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface EntryCapabilities {
  open: boolean;
  preview: boolean;
  download: boolean;
  rename: boolean;
  move: boolean;
  delete: boolean;
  changeVisibility: boolean;
}

export interface Entry {
  id: string;
  parentId: string | null;
  name: string;
  kind: EntryKind;
  size: number;
  contentType: string | null;
  updatedAt: string;
  isPublic: boolean;
  effectivePublic: boolean;
  sortOrder: number;
  description: string;
  capabilities: EntryCapabilities;
}

export interface Breadcrumb {
  id: string;
  name: string;
  path: string;
}

export interface DirectoryResponse {
  current: Entry;
  breadcrumbs: Breadcrumb[];
  items: Entry[];
}

export interface BatchFailure {
  id: string;
  code: string;
  message: string;
}

export interface BatchResult {
  succeeded: string[];
  failed: BatchFailure[];
}
```

- [ ] **Step 5: Implement path and name validation**

Create `src/worker/entry-domain.ts`:

```ts
import { HttpError } from './http';

const RESERVED_ROOT_NAMES = new Set(['api', 'file', 'admin']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateEntryName(value: string, topLevel = false): string {
  const name = value;
  const byteLength = new TextEncoder().encode(name).byteLength;
  const invalid =
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    CONTROL_CHARACTERS.test(name) ||
    byteLength > 255 ||
    (topLevel && RESERVED_ROOT_NAMES.has(name));
  if (invalid) {
    throw new HttpError(400, 'INVALID_ENTRY_NAME', 'Invalid entry name', { name: value });
  }
  return name;
}

export function normalizeVirtualPath(pathname: string): { path: string; segments: string[] } {
  const rawSegments = pathname.replace(/\\/g, '/').split('/').filter(Boolean);
  let segments: string[];
  try {
    segments = rawSegments.map((segment, index) => validateEntryName(decodeURIComponent(segment), index === 0));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_PATH', 'Invalid encoded path');
  }
  return { path: segments.length ? `/${segments.join('/')}` : '/', segments };
}

export function encodeVirtualPath(segments: string[]): string {
  return segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : '/';
}

export function storageKeyForEntry(id: string): string {
  return `blobs/${id}`;
}
```

- [ ] **Step 6: Run tests, migration, and commit**

```bash
npm run test:worker -- tests/worker/entry-domain.test.ts
npx wrangler d1 migrations apply ilist-db --local
npm run check
```

Expected: domain tests pass, migration `0002_entries.sql` applies, and the build passes.

```bash
git add migrations/0002_entries.sql src/worker/entry-domain.ts src/worker/types.ts tests/worker vitest.worker.config.ts
git commit -m "feat: add virtual filesystem schema"
```

---

### Task 3: Implement Entry Queries, Path Resolution, and Capabilities

**Files:**
- Modify: `src/worker/db.ts`
- Create: `src/worker/entries.ts`
- Create: `tests/worker/entries.test.ts`

**Interfaces:**
- Consumes: `EntryRow`, `Entry`, `DirectoryResponse`, and normalized path segments from Task 2.
- Produces: `getEntryById()`, `getChildByName()`, `resolveEntryPath()`, `listDirectory()`, `listDescendants()`, `isEffectivelyPublic()`, and `entryToApi()`.

- [ ] **Step 1: Write failing entry-query tests**

Create `tests/worker/entries.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listDirectory, resolveEntryPath } from '../../src/worker/entries';

async function seed(): Promise<void> {
  const now = '2026-07-10T00:00:00.000Z';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO entries VALUES (?, ?, ?, 'folder', NULL, 0, NULL, NULL, 'ready', 1, 0, '', ?, ?)`).bind(
      'r2', 'root', 'R2', now, now,
    ),
    env.DB.prepare(`INSERT INTO entries VALUES (?, ?, ?, 'folder', NULL, 0, NULL, NULL, 'ready', 1, 0, '', ?, ?)`).bind(
      'private', 'r2', 'Private', now, now,
    ),
    env.DB.prepare(`UPDATE entries SET is_public = 0 WHERE id = 'private'`),
    env.DB.prepare(`INSERT INTO entries VALUES (?, ?, ?, 'file', ?, 12, 'text/plain', 'etag', 'ready', 1, 0, '', ?, ?)`).bind(
      'readme', 'r2', 'README.txt', 'blobs/readme', now, now,
    ),
  ]);
}

describe('entries', () => {
  it('resolves a decoded virtual path', async () => {
    await seed();
    await expect(resolveEntryPath(env.DB, '/R2/README.txt', true)).resolves.toMatchObject({ id: 'readme' });
  });

  it('filters hidden children for guests and returns capabilities for admins', async () => {
    await seed();
    const guest = await listDirectory(env.DB, '/R2', false);
    expect(guest.items.map((entry) => entry.name)).toEqual(['README.txt']);
    expect(guest.items[0].capabilities.rename).toBe(false);

    const admin = await listDirectory(env.DB, '/R2', true);
    expect(admin.items.map((entry) => entry.name)).toEqual(['Private', 'README.txt']);
    expect(admin.items[0].capabilities.rename).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:worker -- tests/worker/entries.test.ts
```

Expected: FAIL because `src/worker/entries.ts` does not exist.

- [ ] **Step 3: Add focused D1 query functions**

Append these entry-specific exports to `src/worker/db.ts`, keeping the old object functions for compatibility:

```ts
import type { EntryRow } from './types';

export async function getEntryById(db: D1Database, id: string): Promise<EntryRow | null> {
  return db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
}

export async function getChildByName(db: D1Database, parentId: string, name: string): Promise<EntryRow | null> {
  return db.prepare('SELECT * FROM entries WHERE parent_id = ? AND name = ?').bind(parentId, name).first<EntryRow>();
}

export async function listChildRows(db: D1Database, parentId: string): Promise<EntryRow[]> {
  const result = await db
    .prepare(`SELECT * FROM entries WHERE parent_id = ? AND status = 'ready' ORDER BY kind DESC, sort_order ASC, name ASC`)
    .bind(parentId)
    .all<EntryRow>();
  return result.results ?? [];
}

export async function listAncestorRows(db: D1Database, id: string): Promise<EntryRow[]> {
  const result = await db
    .prepare(`
      WITH RECURSIVE ancestors(id, depth) AS (
        SELECT id, 0 FROM entries WHERE id = ?
        UNION ALL
        SELECT parent.id, child.depth + 1
        FROM entries parent
        JOIN entries current ON current.parent_id = parent.id
        JOIN ancestors child ON current.id = child.id
      )
      SELECT entry.* FROM ancestors JOIN entries entry ON entry.id = ancestors.id ORDER BY ancestors.depth ASC
    `)
    .bind(id)
    .all<EntryRow>();
  return result.results ?? [];
}

export async function listDescendantRows(db: D1Database, id: string): Promise<EntryRow[]> {
  const result = await db
    .prepare(`
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 0 FROM entries WHERE id = ?
        UNION ALL
        SELECT child.id, parent.depth + 1
        FROM entries child
        JOIN descendants parent ON child.parent_id = parent.id
      )
      SELECT entry.* FROM descendants JOIN entries entry ON entry.id = descendants.id ORDER BY descendants.depth ASC
    `)
    .bind(id)
    .all<EntryRow>();
  return result.results ?? [];
}
```

- [ ] **Step 4: Implement path resolution and API mapping**

Create `src/worker/entries.ts` with these exports and behavior:

```ts
import { encodeVirtualPath, normalizeVirtualPath } from './entry-domain';
import { getChildByName, getEntryById, listAncestorRows, listChildRows, listDescendantRows } from './db';
import { HttpError } from './http';
import type { Breadcrumb, DirectoryResponse, Entry, EntryCapabilities, EntryRow } from './types';

export async function isEffectivelyPublic(db: D1Database, id: string): Promise<boolean> {
  const rows = await listAncestorRows(db, id);
  return rows.length > 0 && rows.every((row) => row.status === 'ready' && row.is_public === 1);
}

function capabilities(row: EntryRow, admin: boolean): EntryCapabilities {
  const file = row.kind === 'file';
  return {
    open: row.kind === 'folder',
    preview: file,
    download: file,
    rename: admin && row.id !== 'root',
    move: admin && row.id !== 'root',
    delete: admin && row.id !== 'root',
    changeVisibility: admin && row.id !== 'root',
  };
}

export function entryToApi(row: EntryRow, admin: boolean, effectivePublic: boolean): Entry {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    size: row.size,
    contentType: row.content_type,
    updatedAt: row.updated_at,
    isPublic: row.is_public === 1,
    effectivePublic,
    sortOrder: row.sort_order,
    description: row.description,
    capabilities: capabilities(row, admin),
  };
}

export async function resolveEntryPath(db: D1Database, pathname: string, admin: boolean): Promise<EntryRow> {
  const { segments } = normalizeVirtualPath(pathname);
  let current = await getEntryById(db, 'root');
  if (!current) throw new HttpError(500, 'ROOT_ENTRY_MISSING', 'Root entry is missing');
  for (const segment of segments) {
    current = await getChildByName(db, current.id, segment);
    if (!current || current.status !== 'ready' || (!admin && current.is_public !== 1)) {
      throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
    }
  }
  if (!admin && !(await isEffectivelyPublic(db, current.id))) {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  }
  return current;
}

export async function breadcrumbsFor(db: D1Database, id: string): Promise<Breadcrumb[]> {
  const rows = (await listAncestorRows(db, id)).reverse();
  const segments: string[] = [];
  return rows.map((row) => {
    if (row.id !== 'root') segments.push(row.name);
    return { id: row.id, name: row.id === 'root' ? 'ilist' : row.name, path: encodeVirtualPath(segments) };
  });
}

export async function listDirectory(db: D1Database, pathname: string, admin: boolean): Promise<DirectoryResponse> {
  const current = await resolveEntryPath(db, pathname, admin);
  if (current.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'Entry is not a folder');
  const rows = await listChildRows(db, current.id);
  const visible = admin ? rows : rows.filter((row) => row.is_public === 1);
  return {
    current: entryToApi(current, admin, await isEffectivelyPublic(db, current.id)),
    breadcrumbs: await breadcrumbsFor(db, current.id),
    items: await Promise.all(visible.map(async (row) => entryToApi(row, admin, await isEffectivelyPublic(db, row.id)))),
  };
}

export async function listDescendants(db: D1Database, id: string): Promise<EntryRow[]> {
  return listDescendantRows(db, id);
}
```

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:worker -- tests/worker/entries.test.ts
npm run check
```

Expected: path, visibility, and capability tests pass.

```bash
git add src/worker/db.ts src/worker/entries.ts tests/worker/entries.test.ts
git commit -m "feat: resolve virtual filesystem entries"
```

---

### Task 4: Add the Idempotent Legacy Object Migration

**Files:**
- Create: `scripts/lib/legacy-entries.mjs`
- Create: `scripts/lib/legacy-entries.d.mts`
- Create: `scripts/migrate-objects.mjs`
- Modify: `package.json`
- Create: `tests/scripts/legacy-migration.test.ts`

**Interfaces:**
- Consumes: old `ObjectRow` shape and the `entries` schema.
- Produces: deterministic folder/file IDs, `buildLegacyEntries(rows)`, `entriesToSql(entries)`, and `npm run migrate:objects -- --local|--remote`.

- [ ] **Step 1: Write the failing conversion test**

Create `tests/scripts/legacy-migration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildLegacyEntries } from '../../scripts/lib/legacy-entries.mjs';

describe('legacy object migration', () => {
  it('creates each folder once and preserves the physical key', () => {
    const rows = [
      {
        key: '资料/项目/a.txt',
        name: 'a.txt',
        size: 4,
        content_type: 'text/plain',
        etag: 'etag-a',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 1,
        sort_order: 0,
        description: '',
      },
      {
        key: '资料/项目/b.txt',
        name: 'b.txt',
        size: 5,
        content_type: 'text/plain',
        etag: 'etag-b',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 0,
        sort_order: 1,
        description: 'hidden',
      },
    ];
    const entries = buildLegacyEntries(rows);
    expect(entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.name)).toEqual(['资料', '项目']);
    expect(entries.find((entry) => entry.name === 'a.txt')).toMatchObject({
      storage_key: '资料/项目/a.txt',
      parent_path: '资料/项目',
    });
    expect(buildLegacyEntries(rows).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:ui -- tests/scripts/legacy-migration.test.ts
```

Expected: FAIL because `scripts/lib/legacy-entries.mjs` does not exist.

- [ ] **Step 3: Implement deterministic conversion and SQL generation**

Create `scripts/lib/legacy-entries.mjs` with Node `createHash('sha256')` IDs:

```js
import { createHash } from 'node:crypto';

function idFor(kind, value) {
  return `legacy-${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function assertName(name, topLevel, sourceKey) {
  const invalid = !name.trim() || name === '.' || name === '..' || name.includes('/') || /[\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name, 'utf8') > 255;
  if (invalid || (topLevel && ['api', 'file', 'admin'].includes(name))) {
    throw new Error(`Legacy object ${sourceKey} contains an invalid virtual name: ${name}`);
  }
}

export function buildLegacyEntries(rows) {
  const folders = new Map();
  const files = [];
  for (const row of rows) {
    const parts = row.key.split('/').filter(Boolean);
    const fileSegment = parts.pop();
    if (!fileSegment) continue;
    let parentId = 'root';
    let parentPath = '';
    const rowFolderPaths = [];
    for (const [index, segment] of parts.entries()) {
      assertName(segment, index === 0, row.key);
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      rowFolderPaths.push(path);
      if (!folders.has(path)) {
        folders.set(path, {
          id: idFor('folder', path),
          parent_id: parentId,
          parent_path: parentPath,
          name: segment,
          kind: 'folder',
          storage_key: null,
          size: 0,
          content_type: null,
          etag: null,
          status: 'ready',
          is_public: 0,
          sort_order: 0,
          description: '',
          created_at: row.updated_at,
          updated_at: row.updated_at,
        });
      }
      parentId = folders.get(path).id;
      parentPath = path;
    }
    if (row.is_public === 1) {
      for (const path of rowFolderPaths) folders.get(path).is_public = 1;
    }
    const virtualName = row.name || fileSegment;
    assertName(virtualName, parts.length === 0, row.key);
    files.push({
      id: idFor('file', row.key),
      parent_id: parentId,
      parent_path: parentPath,
      name: virtualName,
      kind: 'file',
      storage_key: row.key,
      size: row.size,
      content_type: row.content_type,
      etag: row.etag,
      status: 'ready',
      is_public: row.is_public,
      sort_order: row.sort_order,
      description: row.description,
      created_at: row.updated_at,
      updated_at: row.updated_at,
    });
  }
  const entries = [...folders.values(), ...files];
  const siblingNames = new Set();
  for (const entry of entries) {
    const key = `${entry.parent_id}\u0000${entry.name}`;
    if (siblingNames.has(key)) {
      throw new Error(`Legacy objects contain duplicate virtual name under ${entry.parent_path || '/'}: ${entry.name}`);
    }
    siblingNames.add(key);
  }
  return entries;
}

function sqlValue(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function entriesToSql(entries) {
  return entries.map((entry) => `INSERT OR IGNORE INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag,
    status, is_public, sort_order, description, created_at, updated_at
  ) VALUES (${[
    entry.id, entry.parent_id, entry.name, entry.kind, entry.storage_key,
    entry.size, entry.content_type, entry.etag, entry.status, entry.is_public,
    entry.sort_order, entry.description, entry.created_at, entry.updated_at,
  ].map(sqlValue).join(', ')});`).join('\n');
}
```

Create `scripts/lib/legacy-entries.d.mts` with explicit input/output declarations so strict TypeScript can type-check the test:

```ts
export interface LegacyObjectRow {
  key: string;
  name: string;
  size: number;
  content_type: string | null;
  etag: string | null;
  updated_at: string;
  is_public: number;
  sort_order: number;
  description: string;
}

export interface LegacyEntry {
  id: string;
  parent_id: string;
  parent_path: string;
  name: string;
  kind: 'file' | 'folder';
  storage_key: string | null;
  size: number;
  content_type: string | null;
  etag: string | null;
  status: 'ready';
  is_public: number;
  sort_order: number;
  description: string;
  created_at: string;
  updated_at: string;
}

export function buildLegacyEntries(rows: LegacyObjectRow[]): LegacyEntry[];
export function entriesToSql(entries: LegacyEntry[]): string;
```

- [ ] **Step 4: Implement the migration command**

Create `scripts/migrate-objects.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLegacyEntries, entriesToSql } from './lib/legacy-entries.mjs';

const flags = process.argv.slice(2);
if (flags.length !== 1 || !['--local', '--remote'].includes(flags[0])) {
  throw new Error('Usage: npm run migrate:objects -- --local|--remote');
}

const mode = flags[0];
const output = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--command', 'SELECT * FROM objects ORDER BY key', '--json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const payload = JSON.parse(output);
if (!Array.isArray(payload) || !Array.isArray(payload[0]?.results)) {
  throw new Error('Wrangler returned an unexpected D1 JSON response');
}

const rows = payload[0].results;
const entries = buildLegacyEntries(rows);
if (entries.length === 0) {
  process.stdout.write('No legacy objects require migration.\n');
  process.exit(0);
}
const directory = mkdtempSync(join(tmpdir(), 'ilist-migration-'));
const file = join(directory, 'entries.sql');

try {
  writeFileSync(file, entriesToSql(entries), 'utf8');
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--file', file], { stdio: 'inherit' });
  process.stdout.write(`Migrated ${rows.length} objects into ${entries.length} entries.\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Add this script to `package.json`:

```json
"migrate:objects": "node scripts/migrate-objects.mjs"
```

- [ ] **Step 5: Run tests and a local idempotency check**

```bash
npm run test:ui -- tests/scripts/legacy-migration.test.ts
npm run migrate:objects -- --local
npm run migrate:objects -- --local
npx wrangler d1 execute ilist-db --local --command "SELECT COUNT(*) AS count FROM entries"
```

Expected: both migration runs succeed and the second run does not increase the entry count.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/legacy-entries.mjs scripts/lib/legacy-entries.d.mts scripts/migrate-objects.mjs package.json package-lock.json tests/scripts/legacy-migration.test.ts vitest.ui.config.ts
git commit -m "feat: migrate legacy object index"
```

---

### Task 5: Implement Folder Creation, Metadata Changes, Move, and Visibility

**Files:**
- Modify: `src/worker/db.ts`
- Create: `src/worker/file-system.ts`
- Create: `tests/worker/file-system.test.ts`

**Interfaces:**
- Consumes: entry query functions and domain validation from Tasks 2-3.
- Produces: `createFolder()`, `patchEntry()`, `moveEntries()`, `setEntriesVisibility()`, and reusable entry insert/update/delete helpers.

- [ ] **Step 1: Write failing mutation tests**

Create `tests/worker/file-system.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFolder, moveEntries, patchEntry, setEntriesVisibility } from '../../src/worker/file-system';
import { getEntryById } from '../../src/worker/db';

describe('file system mutations', () => {
  it('creates a real empty folder that inherits visibility', async () => {
    const folder = await createFolder(env.DB, { parentId: 'root', name: '资料' });
    expect(folder).toMatchObject({ name: '资料', kind: 'folder', isPublic: true });
    expect(await getEntryById(env.DB, folder.id)).toMatchObject({ parent_id: 'root', storage_key: null });
  });

  it('renames metadata without changing a file storage key', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO entries VALUES (?, 'root', ?, 'file', ?, 4, 'text/plain', 'e', 'ready', 1, 0, '', ?, ?)`).bind(
      'file-a', 'a.txt', 'blobs/file-a', now, now,
    ).run();
    await patchEntry(env.DB, 'file-a', { name: 'b.txt' });
    expect(await getEntryById(env.DB, 'file-a')).toMatchObject({ name: 'b.txt', storage_key: 'blobs/file-a' });
  });

  it('moves entries and rejects a folder cycle', async () => {
    const parent = await createFolder(env.DB, { parentId: 'root', name: 'Parent' });
    const child = await createFolder(env.DB, { parentId: parent.id, name: 'Child' });
    await expect(moveEntries(env.DB, [parent.id], child.id)).resolves.toMatchObject({ succeeded: [], failed: [{ id: parent.id }] });
    const destination = await createFolder(env.DB, { parentId: 'root', name: 'Destination' });
    await expect(moveEntries(env.DB, [child.id], destination.id)).resolves.toMatchObject({ succeeded: [child.id], failed: [] });
  });

  it('changes visibility for every valid selected entry', async () => {
    const one = await createFolder(env.DB, { parentId: 'root', name: 'One' });
    const two = await createFolder(env.DB, { parentId: 'root', name: 'Two' });
    const result = await setEntriesVisibility(env.DB, [one.id, two.id], false);
    expect(result.succeeded).toEqual([one.id, two.id]);
    expect((await getEntryById(env.DB, one.id))?.is_public).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:worker -- tests/worker/file-system.test.ts
```

Expected: FAIL because `src/worker/file-system.ts` does not exist.

- [ ] **Step 3: Add entry mutation queries**

Add to `src/worker/db.ts`:

```ts
export async function insertEntry(db: D1Database, row: EntryRow): Promise<void> {
  await db.prepare(`INSERT INTO entries (
    id, parent_id, name, kind, storage_key, size, content_type, etag,
    status, is_public, sort_order, description, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      row.id, row.parent_id, row.name, row.kind, row.storage_key, row.size,
      row.content_type, row.etag, row.status, row.is_public, row.sort_order,
      row.description, row.created_at, row.updated_at,
    )
    .run();
}

export async function updateEntryFields(
  db: D1Database,
  id: string,
  fields: { parentId?: string; name?: string; description?: string; sortOrder?: number; isPublic?: boolean; status?: EntryStatus },
): Promise<void> {
  const row = await getEntryById(db, id);
  if (!row) throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  await db.prepare(`UPDATE entries SET parent_id = ?, name = ?, description = ?, sort_order = ?, is_public = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(
      fields.parentId ?? row.parent_id,
      fields.name ?? row.name,
      fields.description ?? row.description,
      fields.sortOrder ?? row.sort_order,
      fields.isPublic === undefined ? row.is_public : fields.isPublic ? 1 : 0,
      fields.status ?? row.status,
      new Date().toISOString(),
      id,
    )
    .run();
}

export async function deleteEntryRow(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
}
```

Import `EntryStatus` and `HttpError` at the top of `db.ts`.

- [ ] **Step 4: Implement the mutation service**

Create `src/worker/file-system.ts` with the following public contract:

```ts
import { getChildByName, getEntryById, insertEntry, listAncestorRows, updateEntryFields } from './db';
import { validateEntryName } from './entry-domain';
import { HttpError } from './http';
import { entryToApi, isEffectivelyPublic } from './entries';
import type { BatchResult, Entry } from './types';

export async function requireFolder(db: D1Database, id: string) {
  const row = await getEntryById(db, id);
  if (!row || row.kind !== 'folder' || row.status !== 'ready') {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Folder not found');
  }
  return row;
}

export async function requireMutable(db: D1Database, id: string) {
  const row = await getEntryById(db, id);
  if (!row || row.status !== 'ready') throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
  if (row.id === 'root') throw new HttpError(400, 'ROOT_ENTRY_IMMUTABLE', 'Root entry cannot be changed');
  return row;
}

export async function ensureNameAvailable(db: D1Database, parentId: string, name: string, exceptId?: string): Promise<void> {
  const existing = await getChildByName(db, parentId, name);
  if (existing && existing.id !== exceptId) {
    throw new HttpError(409, 'ENTRY_NAME_CONFLICT', 'Current folder already contains that name', { name });
  }
}

export async function createFolder(db: D1Database, input: { parentId: string; name: string }): Promise<Entry> {
  const parent = await requireFolder(db, input.parentId);
  const name = validateEntryName(input.name, parent.id === 'root');
  await ensureNameAvailable(db, parent.id, name);
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(), parent_id: parent.id, name, kind: 'folder' as const,
    storage_key: null, size: 0, content_type: null, etag: null, status: 'ready' as const,
    is_public: parent.is_public, sort_order: 0, description: '', created_at: now, updated_at: now,
  };
  await insertEntry(db, row);
  return entryToApi(row, true, await isEffectivelyPublic(db, row.id));
}

export async function patchEntry(
  db: D1Database,
  id: string,
  patch: { name?: string; description?: string; sortOrder?: number; isPublic?: boolean },
): Promise<Entry> {
  const row = await requireMutable(db, id);
  const name = patch.name === undefined ? undefined : validateEntryName(patch.name, row.parent_id === 'root');
  if (name) await ensureNameAvailable(db, row.parent_id!, name, row.id);
  await updateEntryFields(db, id, { ...patch, name });
  const updated = (await getEntryById(db, id))!;
  return entryToApi(updated, true, await isEffectivelyPublic(db, id));
}

export async function moveEntries(db: D1Database, ids: string[], destinationId: string): Promise<BatchResult> {
  const destination = await requireFolder(db, destinationId);
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    try {
      const row = await requireMutable(db, id);
      if (row.kind === 'folder') {
        const ancestorIds = new Set((await listAncestorRows(db, destination.id)).map((entry) => entry.id));
        if (ancestorIds.has(row.id)) throw new HttpError(400, 'INVALID_MOVE_TARGET', 'Folder cannot move into itself or a descendant');
      }
      await ensureNameAvailable(db, destination.id, row.name, row.id);
      await updateEntryFields(db, row.id, { parentId: destination.id });
      result.succeeded.push(row.id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'MOVE_FAILED', 'Move failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }
  return result;
}

export async function setEntriesVisibility(db: D1Database, ids: string[], isPublic: boolean): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    try {
      await requireMutable(db, id);
      await updateEntryFields(db, id, { isPublic });
      result.succeeded.push(id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'VISIBILITY_UPDATE_FAILED', 'Visibility update failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }
  return result;
}
```

- [ ] **Step 5: Run tests and commit**

```bash
npm run test:worker -- tests/worker/file-system.test.ts
npm run check
```

Expected: empty-folder, rename, move-cycle, and visibility tests pass.

```bash
git add src/worker/db.ts src/worker/file-system.ts tests/worker/file-system.test.ts
git commit -m "feat: add core entry mutations"
```

---

### Task 6: Add Streamed Upload, Stable File Responses, and Recursive Delete

**Files:**
- Modify: `src/worker/r2.ts`
- Modify: `src/worker/file-system.ts`
- Modify: `src/worker/db.ts`
- Create: `tests/worker/storage.test.ts`

**Interfaces:**
- Consumes: stable entries, R2 binding, and batch results.
- Produces: `uploadFile()`, `streamEntryObject()`, `deleteEntryTrees()`, and `findEntryByStorageKey()`.

- [ ] **Step 1: Write failing storage lifecycle tests**

Create `tests/worker/storage.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deleteEntryTrees, uploadFile } from '../../src/worker/file-system';
import { getEntryById } from '../../src/worker/db';
import { streamEntryObject } from '../../src/worker/r2';

describe('R2 file lifecycle', () => {
  it('uploads a streamed body and marks the entry ready', async () => {
    const request = new Request('https://ilist.example/api/admin/files/file-12345678', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello range',
    });
    const entry = await uploadFile(env, request, {
      id: 'file-12345678', parentId: 'root', name: 'hello.txt',
    });
    expect(entry).toMatchObject({ id: 'file-12345678', name: 'hello.txt', size: 11 });
    expect(await getEntryById(env.DB, entry.id)).toMatchObject({ status: 'ready', storage_key: 'blobs/file-12345678' });
  });

  it('serves a stable ID with Range and attachment headers', async () => {
    const upload = new Request('https://ilist.example/upload', { method: 'PUT', body: 'hello range' });
    const entry = await uploadFile(env, upload, { id: 'file-abcdefgh', parentId: 'root', name: 'hello.txt' });
    const row = (await getEntryById(env.DB, entry.id))!;
    const response = await streamEntryObject(env.R2_BUCKET, row, new Request('https://ilist.example/file', {
      headers: { range: 'bytes=0-4' },
    }), { download: true, publicFile: true });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    await expect(response.text()).resolves.toBe('hello');
  });

  it('recursively deletes a folder and its blobs', async () => {
    const folder = await (await import('../../src/worker/file-system')).createFolder(env.DB, { parentId: 'root', name: 'Folder' });
    await uploadFile(env, new Request('https://ilist.example/upload', { method: 'PUT', body: 'x' }), {
      id: 'file-delete123', parentId: folder.id, name: 'x.txt',
    });
    const result = await deleteEntryTrees(env, [folder.id]);
    expect(result).toEqual({ succeeded: [folder.id], failed: [] });
    expect(await getEntryById(env.DB, folder.id)).toBeNull();
    expect(await env.R2_BUCKET.get('blobs/file-delete123')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:worker -- tests/worker/storage.test.ts
```

Expected: FAIL because upload/delete orchestration and entry streaming do not exist.

- [ ] **Step 3: Add storage-aware D1 helpers**

Add to `src/worker/db.ts`:

```ts
export async function findEntryByStorageKey(db: D1Database, storageKey: string): Promise<EntryRow | null> {
  return db.prepare('SELECT * FROM entries WHERE storage_key = ?').bind(storageKey).first<EntryRow>();
}

export async function finalizeUploadedEntry(
  db: D1Database,
  id: string,
  metadata: { size: number; contentType: string | null; etag: string | null },
): Promise<void> {
  await db.prepare(`UPDATE entries SET size = ?, content_type = ?, etag = ?, status = 'ready', updated_at = ? WHERE id = ?`)
    .bind(metadata.size, metadata.contentType, metadata.etag, new Date().toISOString(), id)
    .run();
}
```

- [ ] **Step 4: Replace path-based R2 helpers with entry-based streaming while retaining legacy helpers**

Add `streamEntryObject` to `src/worker/r2.ts` and keep `keyFromPath`, `putObject`, and `streamObject` until the compatibility task is complete:

```ts
import type { EntryRow } from './types';

function disposition(name: string, download: boolean): string {
  return `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function streamEntryObject(
  bucket: R2Bucket,
  row: EntryRow,
  request: Request,
  options: { download: boolean; publicFile: boolean },
): Promise<Response> {
  if (row.kind !== 'file' || !row.storage_key || row.status !== 'ready') {
    throw new HttpError(404, 'ENTRY_NOT_FOUND', 'File not found');
  }
  const object = await bucket.get(row.storage_key, { range: request.headers, onlyIf: request.headers });
  if (!object) throw new HttpError(404, 'STORAGE_OBJECT_NOT_FOUND', 'File content not found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-disposition', disposition(row.name, options.download));
  headers.set('cache-control', options.publicFile ? 'public, max-age=3600' : 'private, no-store');
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  if (request.headers.has('range') && object.range && 'offset' in object.range) {
    const end = object.range.offset + object.range.length - 1;
    headers.set('content-range', `bytes ${object.range.offset}-${end}/${object.size}`);
    headers.set('content-length', String(object.range.length));
  }
  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: request.headers.has('range') ? 206 : 200,
    headers,
  });
}
```

- [ ] **Step 5: Implement upload and recursive delete orchestration**

Update the existing `src/worker/file-system.ts` imports to include all required D1 helpers, then add the lifecycle exports:

```ts
import {
  deleteEntryRow,
  finalizeUploadedEntry,
  getChildByName,
  getEntryById,
  insertEntry,
  listAncestorRows,
  listDescendantRows,
  updateEntryFields,
} from './db';
import { storageKeyForEntry } from './entry-domain';
import type { Env, EntryRow } from './types';

function validateClientEntryId(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new HttpError(400, 'INVALID_ENTRY_ID', 'Invalid entry ID');
  return id;
}

export async function uploadFile(
  env: Env,
  request: Request,
  input: { id: string; parentId: string; name: string },
) {
  if (!request.body) throw new HttpError(400, 'UPLOAD_BODY_MISSING', 'Upload body is missing');
  const id = validateClientEntryId(input.id);
  const parent = await requireFolder(env.DB, input.parentId);
  const name = validateEntryName(input.name, parent.id === 'root');
  const existing = await getEntryById(env.DB, id);
  if (existing && (
    existing.status !== 'uploading' ||
    existing.parent_id !== parent.id ||
    existing.name !== name ||
    existing.storage_key !== storageKeyForEntry(id)
  )) {
    throw new HttpError(409, 'ENTRY_ID_CONFLICT', 'Upload ID already exists');
  }
  await ensureNameAvailable(env.DB, parent.id, name, existing?.id);
  const now = new Date().toISOString();
  const row: EntryRow = existing ?? {
    id, parent_id: parent.id, name, kind: 'file', storage_key: storageKeyForEntry(id), size: 0,
    content_type: request.headers.get('content-type'), etag: null, status: 'uploading',
    is_public: parent.is_public, sort_order: 0, description: '', created_at: now, updated_at: now,
  };
  if (!existing) await insertEntry(env.DB, row);
  try {
    const object = await env.R2_BUCKET.put(row.storage_key!, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
    });
    await finalizeUploadedEntry(env.DB, id, {
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? request.headers.get('content-type'),
      etag: object.httpEtag || object.etag,
    });
    const ready = (await getEntryById(env.DB, id))!;
    return entryToApi(ready, true, await isEffectivelyPublic(env.DB, id));
  } catch (error) {
    await env.R2_BUCKET.delete(row.storage_key!).catch(() => undefined);
    await deleteEntryRow(env.DB, id).catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Upload failed');
  }
}

export async function deleteEntryTrees(
  env: Env,
  ids: string[],
  options: { maxEntries?: number; deleteBlob?: (key: string) => Promise<void> } = {},
): Promise<BatchResult> {
  const maxEntries = options.maxEntries ?? 1000;
  const deleteBlob = options.deleteBlob ?? ((key) => env.R2_BUCKET.delete(key));
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    try {
      const target = await getEntryById(env.DB, id);
      if (!target || target.id === 'root' || !['ready', 'deleting'].includes(target.status)) {
        throw new HttpError(404, 'ENTRY_NOT_FOUND', 'Entry not found');
      }
      const rows = await listDescendantRows(env.DB, id);
      if (rows.length > maxEntries) throw new HttpError(409, 'OPERATION_LIMIT_EXCEEDED', 'Delete contains too many entries');
      for (const row of rows) {
        if (row.status === 'ready') await updateEntryFields(env.DB, row.id, { status: 'deleting' });
      }
      const failedFiles = new Set<string>();
      for (const row of rows.filter((entry) => entry.kind === 'file')) {
        try { await deleteBlob(row.storage_key!); }
        catch { failedFiles.add(row.id); }
      }
      const keep = new Set<string>(failedFiles);
      for (const failedId of failedFiles) {
        for (const ancestor of await listAncestorRows(env.DB, failedId)) keep.add(ancestor.id);
      }
      for (const row of [...rows].reverse()) {
        if (keep.has(row.id)) await updateEntryFields(env.DB, row.id, { status: 'ready' });
        else await deleteEntryRow(env.DB, row.id);
      }
      if (failedFiles.size) throw new HttpError(502, 'STORAGE_OPERATION_FAILED', 'Some file contents could not be deleted');
      result.succeeded.push(id);
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(500, 'DELETE_FAILED', 'Delete failed');
      result.failed.push({ id, code: known.code, message: known.message });
    }
  }
  return result;
}
```

- [ ] **Step 6: Add the forced-failure delete test**

Extend `tests/worker/storage.test.ts` with a folder containing two files and pass a `deleteBlob` function that throws for one key. Assert that the successful file row is deleted, the failed file and its folder are restored to `ready`, and `failed[0].code` is `STORAGE_OPERATION_FAILED`.

- [ ] **Step 7: Run tests and commit**

```bash
npm run test:worker -- tests/worker/storage.test.ts
npm run check
```

Expected: upload, Range, recursive delete, and partial-failure recovery pass.

```bash
git add src/worker/db.ts src/worker/file-system.ts src/worker/r2.ts tests/worker/storage.test.ts
git commit -m "feat: add r2 file lifecycle"
```

---

### Task 7: Expose the Unified File-System API and Compatibility Routes

**Files:**
- Modify: `src/worker/router.ts`
- Modify: `src/worker/auth.ts`
- Modify: `src/worker/http.ts`
- Create: `tests/worker/router.test.ts`

**Interfaces:**
- Consumes: all Worker services from Tasks 1-6.
- Produces: `/api/fs/*`, authenticated `/api/admin/*` mutations, stable `/file/:id/:name`, and old file-link compatibility.

- [ ] **Step 1: Write failing HTTP integration tests**

Create `tests/worker/router.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const origin = 'https://ilist.example';

async function login(): Promise<string> {
  const response = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

describe('filesystem API', () => {
  it('uses one list endpoint for guest and admin capabilities', async () => {
    const guest = await SELF.fetch(`${origin}/api/fs/list?path=/`);
    expect(guest.status).toBe(200);
    const cookie = await login();
    const admin = await SELF.fetch(`${origin}/api/fs/list?path=/`, { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect((await admin.json() as any).data.current.capabilities.rename).toBe(false);
  });

  it('creates, renames, moves, changes visibility, and deletes through admin routes', async () => {
    const cookie = await login();
    const headers = { cookie, origin, 'content-type': 'application/json' };
    const created = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST', headers, body: JSON.stringify({ parentId: 'root', name: 'Docs' }),
    });
    expect(created.status).toBe(200);
    const entry = (await created.json() as any).data;
    const renamed = await SELF.fetch(`${origin}/api/admin/entries/${entry.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Documents' }),
    });
    expect(renamed.status).toBe(200);
    const removed = await SELF.fetch(`${origin}/api/admin/entries/delete`, {
      method: 'POST', headers, body: JSON.stringify({ ids: [entry.id] }),
    });
    expect((await removed.json() as any).data.succeeded).toEqual([entry.id]);
  });

  it('requires same-origin and authentication for mutations', async () => {
    const unauthenticated = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ parentId: 'root', name: 'Docs' }),
    });
    expect(unauthenticated.status).toBe(401);

    const cookie = await login();
    const response = await SELF.fetch(`${origin}/api/admin/folders`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ parentId: 'root', name: 'Docs' }),
    });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the HTTP tests to verify they fail**

```bash
npm run test:worker -- tests/worker/router.test.ts
```

Expected: FAIL because the new routes do not exist.

- [ ] **Step 3: Add optional authentication and strict mutation checks**

Keep `currentUser()` public in `auth.ts`. In `router.ts`, use it for `/api/fs/*`; use `requireAdmin()` followed by `requireSameOrigin()` for every non-GET admin operation. Login and logout also validate same-origin when an `Origin` header is present, so CLI smoke tests can omit it while browsers remain protected.

Update the `HttpError` catch path to call:

```ts
return withSecurityHeaders(fail(error.status, error.code, error.message, error.details));
```

- [ ] **Step 4: Route the new read and admin APIs**

Implement these exact route mappings in `router.ts`:

```ts
GET  /api/fs/list                 -> listDirectory(env.DB, path, Boolean(await currentUser(...)))
GET  /api/fs/entries/:id          -> get entry, verify ready/effective public unless admin, return entryToApi
POST /api/admin/folders           -> createFolder
PUT  /api/admin/files/:id         -> uploadFile using parentId and name query parameters
PATCH /api/admin/entries/:id      -> patchEntry
POST /api/admin/entries/move      -> moveEntries
POST /api/admin/entries/delete    -> deleteEntryTrees
POST /api/admin/entries/visibility -> setEntriesVisibility
```

For each JSON body, validate arrays with `Array.isArray`, strings with `typeof value === 'string'`, and booleans with `typeof value === 'boolean'`; otherwise throw `HttpError(400, 'INVALID_REQUEST', 'Invalid request body')`.

- [ ] **Step 5: Route stable and legacy file URLs**

For `/file/*`, split the decoded suffix. When the first segment matches `^[A-Za-z0-9_-]{8,80}$` and resolves to an entry, authorize the entry and call `streamEntryObject`. Otherwise, run the old key lookup; after locating the migrated entry by storage key, authorize it and return `302` to `/file/<entry.id>/<encodeURIComponent(entry.name)>`. Remove the old public/admin object APIs when the React client switches because keeping writable path-based APIs would bypass the stable-entry model.

Hidden files return `404 ENTRY_NOT_FOUND` to guests. Stable routes use `?download=1` to select attachment disposition.

- [ ] **Step 6: Expand integration coverage**

Add tests that:

- Upload a file through `PUT /api/admin/files/:id` and read it through the stable URL.
- Request `Range: bytes=0-1` and assert `206` plus `Content-Range`.
- Hide the file and assert a guest receives 404 while the admin cookie receives 200 with `private, no-store`.
- Insert an old `objects` row plus matching migrated entry and assert the old URL returns 302.
- Send malformed IDs/arrays and assert stable error codes.

- [ ] **Step 7: Run tests and commit**

```bash
npm run test:worker -- tests/worker/router.test.ts
npm run check
```

Expected: all new routes and legacy file redirects pass.

```bash
git add src/worker/auth.ts src/worker/http.ts src/worker/router.ts tests/worker/router.test.ts
git commit -m "feat: expose unified filesystem api"
```

---

### Task 8: Build the Frontend API Layer and URL/Session Hooks

**Files:**
- Create: `src/ui/types/entries.ts`
- Create: `src/ui/api/client.ts`
- Create: `src/ui/api/entries.ts`
- Create: `src/ui/api/session.ts`
- Create: `src/ui/hooks/useExplorerLocation.ts`
- Create: `src/ui/hooks/useDirectory.ts`
- Create: `src/ui/hooks/useSelection.ts`
- Create: `src/ui/hooks/useSession.ts`
- Create: `tests/ui/location-and-session.test.tsx`

**Interfaces:**
- Consumes: API contract from Task 7.
- Produces: browser `Entry` types, `ApiError`, typed requests, and focused explorer/session hooks used by every UI task.

- [ ] **Step 1: Write failing URL and session tests**

Create `tests/ui/location-and-session.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExplorerLocation } from '../../src/ui/hooks/useExplorerLocation';
import { useSession } from '../../src/ui/hooks/useSession';

describe('explorer foundations', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/R2/Projects');
    vi.restoreAllMocks();
  });

  it('pushes folders and preview IDs into browser history', () => {
    const { result } = renderHook(() => useExplorerLocation());
    act(() => result.current.openPath('/R2/项目'));
    expect(location.pathname).toBe('/R2/%E9%A1%B9%E7%9B%AE');
    act(() => result.current.openPreview('file-12345678'));
    expect(new URL(location.href).searchParams.get('preview')).toBe('file-12345678');
    act(() => result.current.closePreview());
    expect(new URL(location.href).searchParams.has('preview')).toBe(false);
  });

  it('treats a 401 me response as guest state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })));
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.status).toBe('guest'));
    expect(result.current.user).toBeNull();
  });
});
```

- [ ] **Step 2: Run the UI test to verify it fails**

```bash
npm run test:ui -- tests/ui/location-and-session.test.tsx
```

Expected: FAIL because the hooks do not exist.

- [ ] **Step 3: Define browser-facing types and API errors**

Create `src/ui/types/entries.ts`:

```ts
export type EntryKind = 'file' | 'folder';

export interface EntryCapabilities {
  open: boolean;
  preview: boolean;
  download: boolean;
  rename: boolean;
  move: boolean;
  delete: boolean;
  changeVisibility: boolean;
}

export interface Entry {
  id: string;
  parentId: string | null;
  name: string;
  kind: EntryKind;
  size: number;
  contentType: string | null;
  updatedAt: string;
  isPublic: boolean;
  effectivePublic: boolean;
  sortOrder: number;
  description: string;
  capabilities: EntryCapabilities;
}

export interface Breadcrumb { id: string; name: string; path: string }
export interface DirectoryResponse { current: Entry; breadcrumbs: Breadcrumb[]; items: Entry[] }
export interface BatchFailure { id: string; code: string; message: string }
export interface BatchResult { succeeded: string[]; failed: BatchFailure[] }
export interface AdminUser { username: string }
export type EntryPatch = { name?: string; description?: string; sortOrder?: number; isPublic?: boolean };
```

Create `src/ui/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function unwrap<T>(response: Response): Promise<T> {
  const payload = await response.json() as { ok: boolean; data?: T; error?: { code?: string; message?: string; details?: unknown } };
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new ApiError(response.status, payload.error?.code ?? `HTTP_${response.status}`, payload.error?.message ?? 'Request failed', payload.error?.details);
  }
  return payload.data;
}

export async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  return unwrap<T>(await fetch(url, { ...init, headers, credentials: 'same-origin' }));
}
```

- [ ] **Step 4: Add typed entry and session clients**

Create `src/ui/api/entries.ts`:

```ts
import { jsonRequest, unwrap } from './client';
import type { BatchResult, DirectoryResponse, Entry, EntryPatch } from '../types/entries';

export async function listDirectory(path: string, signal?: AbortSignal): Promise<DirectoryResponse> {
  const query = new URLSearchParams({ path });
  return unwrap<DirectoryResponse>(await fetch(`/api/fs/list?${query}`, { signal, credentials: 'same-origin' }));
}

export async function getEntry(id: string, signal?: AbortSignal): Promise<Entry> {
  return unwrap<Entry>(await fetch(`/api/fs/entries/${encodeURIComponent(id)}`, { signal, credentials: 'same-origin' }));
}

export function createFolder(parentId: string, name: string): Promise<Entry> {
  return jsonRequest('/api/admin/folders', { method: 'POST', body: JSON.stringify({ parentId, name }) });
}

export function patchEntry(id: string, patch: EntryPatch): Promise<Entry> {
  return jsonRequest(`/api/admin/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function moveEntries(ids: string[], destinationId: string): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/move', { method: 'POST', body: JSON.stringify({ ids, destinationId }) });
}

export function deleteEntries(ids: string[]): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/delete', { method: 'POST', body: JSON.stringify({ ids }) });
}

export function setVisibility(ids: string[], isPublic: boolean): Promise<BatchResult> {
  return jsonRequest('/api/admin/entries/visibility', { method: 'POST', body: JSON.stringify({ ids, isPublic }) });
}

export function fileUrl(entry: Pick<Entry, 'id' | 'name'>, download = false): string {
  const url = `/file/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.name)}`;
  return download ? `${url}?download=1` : url;
}

export function childPath(parentPath: string, name: string): string {
  const base = parentPath === '/' ? '' : parentPath.replace(/\/$/, '');
  return `${base}/${encodeURIComponent(name)}`;
}
```

Create `src/ui/api/session.ts`:

```ts
import { jsonRequest, unwrap } from './client';
import type { AdminUser } from '../types/entries';

export async function me(): Promise<AdminUser> {
  return unwrap<AdminUser>(await fetch('/api/admin/me', { credentials: 'same-origin' }));
}

export function login(username: string, password: string): Promise<AdminUser> {
  return jsonRequest('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export async function logout(): Promise<void> {
  await jsonRequest<Record<string, never>>('/api/admin/logout', { method: 'POST' });
}
```

- [ ] **Step 5: Implement URL and state hooks**

Create `useExplorerLocation.ts`:

```ts
import { useCallback, useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

function snapshot(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function canonicalPath(path: string): string {
  const segments = path.split('/').filter(Boolean).map((segment) => encodeURIComponent(decodeURIComponent(segment)));
  return segments.length ? `/${segments.join('/')}` : '/';
}

function publish(url: URL): void {
  history.pushState(null, '', `${url.pathname}${url.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useExplorerLocation() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const path = window.location.pathname;
  const previewId = new URL(window.location.href).searchParams.get('preview');
  const openPath = useCallback((nextPath: string) => publish(new URL(canonicalPath(nextPath), window.location.origin)), []);
  const openPreview = useCallback((id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('preview', id);
    publish(url);
  }, []);
  const closePreview = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('preview');
    publish(url);
  }, []);
  return { path, previewId, openPath, openPreview, closePreview };
}
```

Create `useSession.ts` with states `checking | guest | admin`; `ApiError` 401 resolves to guest, other errors populate `error`. `signIn` and `signOut` update state only after their requests succeed.

Create `useSelection.ts` as a `Set<string>` wrapper exposing `toggle`, `selectAll`, and `clear`.

Create `useDirectory.ts` that aborts the previous request on path/session changes, retains old data during manual refresh, and ignores `AbortError`.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- tests/ui/location-and-session.test.tsx
npm run check
```

Expected: history and guest-session tests pass.

```bash
git add src/ui/types src/ui/api src/ui/hooks tests/ui/location-and-session.test.tsx
git commit -m "feat: add explorer data and navigation hooks"
```

---

### Task 9: Replace the Dashboard with the Classic Shared Explorer Shell

**Files:**
- Create: `src/ui/app/ExplorerApp.tsx`
- Create: `src/ui/features/explorer/Breadcrumbs.tsx`
- Create: `src/ui/features/explorer/ExplorerToolbar.tsx`
- Create: `src/ui/features/explorer/FileList.tsx`
- Create: `src/ui/features/explorer/FileGrid.tsx`
- Create: `src/ui/features/explorer/EntryRow.tsx`
- Create: `src/ui/features/explorer/EmptyState.tsx`
- Create: `src/ui/features/explorer/LoginDialog.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/main.tsx`
- Modify: `src/ui/styles.css`
- Create: `tests/ui/explorer.test.tsx`

**Interfaces:**
- Consumes: hooks and typed clients from Task 8.
- Produces: the single guest/admin explorer shell, classic list/grid rendering, search, sort, login dialog, loading, empty, and retry states.

- [ ] **Step 1: Write the failing explorer interaction test**

Create `tests/ui/explorer.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';

const guestError = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } };
const root = {
  ok: true,
  data: {
    current: { id: 'root', parentId: null, name: '', kind: 'folder', size: 0, contentType: null, updatedAt: '2026-07-10T00:00:00Z', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false } },
    breadcrumbs: [{ id: 'root', name: 'ilist', path: '/' }],
    items: [
      { id: 'docs', parentId: 'root', name: 'Docs', kind: 'folder', size: 0, contentType: null, updatedAt: '2026-07-10T00:00:00Z', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false } },
      { id: 'readme-file', parentId: 'root', name: 'README.txt', kind: 'file', size: 12, contentType: 'text/plain', updatedAt: '2026-07-10T00:00:00Z', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', capabilities: { open: false, preview: true, download: true, rename: false, move: false, delete: false, changeVisibility: false } },
    ],
  },
};

describe('ExplorerApp', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(guestError), { status: 401 });
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(root), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('makes the file surface primary and follows folder/file click rules', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: /Docs/ })).toBeVisible();
    expect(screen.queryByText('listed size')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /README.txt/ }));
    expect(new URL(location.href).searchParams.get('preview')).toBe('readme-file');
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }));
    await waitFor(() => expect(location.pathname).toBe('/Docs'));
  });
});
```

- [ ] **Step 2: Run the explorer test to verify it fails**

```bash
npm run test:ui -- tests/ui/explorer.test.tsx
```

Expected: FAIL because the current dashboard still renders summary and details panels.

- [ ] **Step 3: Build small explorer components**

Implement these component contracts:

```ts
Breadcrumbs({ items, onOpen }: { items: Breadcrumb[]; onOpen(path: string): void })
ExplorerToolbar({ query, sort, view, sessionStatus, selectionCount, onQuery, onSort, onView, onLogin, onUpload, onCreateFolder })
EntryRow({ entry, selected, admin, onOpen, onPreview, onToggle, onMenu })
FileList({ entries, selectedIds, admin, handlers })
FileGrid({ entries, selectedIds, admin, handlers })
EmptyState({ query, admin })
LoginDialog({ open, busy, error, onClose, onSubmit })
```

Use semantic `header`, `nav`, `main`, `section`, and `table`/list elements. Row action buttons stop propagation. Folders call `openPath(joinPath(currentPath, entry.name))`; files call `openPreview(entry.id)`.

- [ ] **Step 4: Implement `ExplorerApp` orchestration**

`ExplorerApp` must:

1. Read `{ path, previewId }` from `useExplorerLocation`.
2. Read session from `useSession`.
3. Load the current directory with `useDirectory(path, session.status)`.
4. Keep query, sort field/order, and view mode locally; persist only view mode to `localStorage`.
5. Filter the current directory by name and description, then sort folders before files.
6. Show upload/new-folder commands only for `admin`.
7. Show no summary cards, path-inspector row, or permanent details panel.
8. Show skeleton rows on first load, an inline retry banner on refresh error, and `EmptyState` when filtered results are empty.
9. Open `LoginDialog` when pathname is `/admin`, then return to `/` or the last non-admin path after successful login.

Replace `src/ui/App.tsx` with a thin export:

```tsx
import { ExplorerApp } from './app/ExplorerApp';

export function App() {
  return <ExplorerApp />;
}
```

- [ ] **Step 5: Replace dashboard CSS with the functional classic layout**

Keep existing color variables where practical, but define a centered `max-width: 1080px` explorer, 56px top bar, compact breadcrumbs, 48-56px list rows, and stable grid columns using `repeat(auto-fill, minmax(150px, 1fr))`. Remove CSS for `.summaryStrip`, `.pathInspector`, `.contentGrid`, `.detailsPane`, and the old embedded `.uploadPanel`.

Do not perform the later visual-polish pass; this task only establishes hierarchy, readable states, focus rings, and non-overlapping responsive dimensions.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- tests/ui/explorer.test.tsx
npm run check
```

Expected: explorer click rules pass and the old dashboard regions are gone.

```bash
git add src/ui/App.tsx src/ui/app src/ui/features/explorer src/ui/main.tsx src/ui/styles.css tests/ui/explorer.test.tsx
git commit -m "feat: build shared classic file explorer"
```

---

### Task 10: Add URL-Driven File Preview

**Files:**
- Create: `src/ui/features/preview/preview-kind.ts`
- Create: `src/ui/features/preview/PreviewOverlay.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Create: `tests/ui/preview.test.tsx`

**Interfaces:**
- Consumes: `previewId`, `getEntry()`, and stable `fileUrl()`.
- Produces: `previewKind(entry)`, a closable URL-driven overlay, safe text loading, and media/PDF fallbacks.

- [ ] **Step 1: Write failing preview tests**

Create `tests/ui/preview.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewOverlay } from '../../src/ui/features/preview/PreviewOverlay';
import { previewKind } from '../../src/ui/features/preview/preview-kind';

const base = { id: 'file-image1', parentId: 'root', name: 'photo.png', kind: 'file' as const, size: 10, contentType: 'image/png', updatedAt: '', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', capabilities: { open: false, preview: true, download: true, rename: false, move: false, delete: false, changeVisibility: false } };

describe('preview', () => {
  it('selects supported preview kinds', () => {
    expect(previewKind(base)).toBe('image');
    expect(previewKind({ ...base, name: 'notes.md', contentType: 'text/markdown' })).toBe('text');
    expect(previewKind({ ...base, name: 'archive.zip', contentType: 'application/zip' })).toBe('fallback');
  });

  it('renders an image and closes through the supplied history action', async () => {
    const onClose = vi.fn();
    render(<PreviewOverlay entry={base} onClose={onClose} />);
    expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', expect.stringContaining('/file/file-image1/'));
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reads only the first 512 KiB for text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hello text', { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PreviewOverlay entry={{ ...base, name: 'notes.txt', contentType: 'text/plain' }} onClose={() => undefined} />);
    expect(await screen.findByText('hello text')).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { Range: 'bytes=0-524287' } })));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:ui -- tests/ui/preview.test.tsx
```

Expected: FAIL because preview modules do not exist.

- [ ] **Step 3: Implement preview classification**

`previewKind(entry)` returns `image`, `video`, `audio`, `pdf`, `text`, or `fallback` using MIME type first and lowercase extension second. Treat `.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`, `.log`, `.css`, `.js`, `.ts`, `.tsx`, `.jsx`, `.html`, and `.xml` as text. Do not classify Office or archives as previewable.

- [ ] **Step 4: Implement the overlay**

`PreviewOverlay` renders:

- `<img>` for image.
- `<video controls>` for video.
- `<audio controls>` for audio.
- `<iframe title="PDF preview">` for PDF.
- A cancellable fetch with `Range: bytes=0-524287` and `<pre>` for text/Markdown; never inject HTML.
- Metadata and a download link for fallback.

The header contains the file name, explicit download link, and icon-only close button with `aria-label="Close preview"`. Escape closes the overlay. Add `role="dialog"`, `aria-modal="true"`, and restore focus to the previously active element.

- [ ] **Step 5: Connect preview data to `ExplorerApp`**

When `previewId` is non-null, request `getEntry(previewId, signal)`. Render loading and inline failure states inside the overlay. Closing calls `closePreview()` so browser history remains authoritative.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- tests/ui/preview.test.tsx
npm run check
```

Expected: classification, media rendering, limited text fetch, and close behavior pass.

```bash
git add src/ui/features/preview src/ui/app/ExplorerApp.tsx tests/ui/preview.test.tsx
git commit -m "feat: add file preview overlay"
```

---

### Task 11: Add Admin Entry Menus, Dialogs, and Multi-Select Operations

**Files:**
- Create: `src/ui/features/explorer/SelectionToolbar.tsx`
- Create: `src/ui/features/explorer/EntryActionMenu.tsx`
- Create: `src/ui/features/operations/RenameDialog.tsx`
- Create: `src/ui/features/operations/FolderPickerDialog.tsx`
- Create: `src/ui/features/operations/DeleteDialog.tsx`
- Create: `src/ui/features/operations/PropertiesDialog.tsx`
- Modify: `src/ui/features/explorer/EntryRow.tsx`
- Modify: `src/ui/features/explorer/FileList.tsx`
- Modify: `src/ui/features/explorer/FileGrid.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Create: `tests/ui/operations.test.tsx`

**Interfaces:**
- Consumes: entry capabilities and mutation clients.
- Produces: one shared action definition for context/ellipsis menus, application dialogs, selection toolbar, and partial-result summaries.

- [ ] **Step 1: Write failing admin-operation tests**

Create `tests/ui/operations.test.tsx` with an authenticated directory response containing one file and one folder. Mock mutation endpoints and assert:

```tsx
it('switches to a selection toolbar and submits a batch visibility change', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select report.pdf' }));
  expect(screen.getByText('1 selected')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Hide selected' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    '/api/admin/entries/visibility',
    expect.objectContaining({ method: 'POST' }),
  ));
});

it('uses an application dialog instead of window.confirm for delete', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for report.pdf' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(screen.getByRole('dialog', { name: 'Delete report.pdf' })).toBeVisible();
  expect(confirmSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:ui -- tests/ui/operations.test.tsx
```

Expected: FAIL because selection toolbar and operation dialogs do not exist.

- [ ] **Step 3: Create one capability-driven action model**

`EntryActionMenu` builds actions from an entry's `capabilities` and callbacks. The exact order is:

1. Open for folders or Preview for files.
2. Download for files.
3. Copy link for files.
4. Rename, Move, Properties when allowed.
5. Publish/Hide when allowed.
6. Delete when allowed, separated and styled as destructive.

The row ellipsis and desktop `contextmenu` event open the same component and callbacks. Menus close on Escape, outside click, directory change, and action selection.

- [ ] **Step 4: Implement focused operation dialogs**

- `RenameDialog`: validates non-empty input, submits `patchEntry(id, { name })`, and displays `ENTRY_NAME_CONFLICT` inline.
- `FolderPickerDialog`: starts at root, uses `listDirectory` to show folders only, supports breadcrumb navigation, disables the selected entry and descendants as destinations, and submits `moveEntries(ids, destinationId)`.
- `DeleteDialog`: lists the selected entry count and summed size of directly selected files, explains that folders are deleted recursively, requires an explicit destructive button, and calls `deleteEntries(ids)`.
- `PropertiesDialog`: edits description, sort order, and own public state via `patchEntry`.

Each dialog owns only form state; `ExplorerApp` owns which dialog/entries are active and calls `refresh()` after success.

- [ ] **Step 5: Implement selection mode**

Checkboxes are visible for administrators on row hover/focus and remain visible while any selection exists. `SelectionToolbar` replaces the normal command cluster when selection is non-empty and exposes Move, Publish, Hide, Delete, and Clear. It must not expose batch download.

When a batch response has failures, show a summary such as `3 completed, 1 failed` and preserve failed IDs in selection. On complete success, clear selection.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- tests/ui/operations.test.tsx
npm run check
```

Expected: selection, shared actions, dialogs, and no-native-confirm tests pass.

```bash
git add src/ui/features/explorer src/ui/features/operations src/ui/app/ExplorerApp.tsx tests/ui/operations.test.tsx
git commit -m "feat: add explorer management operations"
```

---

### Task 12: Add the Two-File Upload Queue with Real Progress

**Files:**
- Create: `src/ui/api/uploads.ts`
- Create: `src/ui/features/uploads/upload-reducer.ts`
- Create: `src/ui/features/uploads/useUploadQueue.ts`
- Create: `src/ui/features/uploads/UploadPanel.tsx`
- Create: `src/ui/features/uploads/UploadTaskRow.tsx`
- Modify: `src/ui/features/explorer/ExplorerToolbar.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Create: `tests/ui/uploads.test.tsx`

**Interfaces:**
- Consumes: current directory ID and upload API.
- Produces: `uploadFileWithProgress()`, queue reducer, maximum concurrency 2, cancel, retry, drag/drop, and directory refresh on completion.

- [ ] **Step 1: Write failing reducer and queue tests**

Create `tests/ui/uploads.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { uploadReducer } from '../../src/ui/features/uploads/upload-reducer';
import { useUploadQueue } from '../../src/ui/features/uploads/useUploadQueue';

describe('upload queue', () => {
  it('tracks byte progress and retryable failure', () => {
    const task = { id: 'upload-12345678', parentId: 'root', file: new File(['hello'], 'a.txt'), status: 'queued' as const, uploadedBytes: 0, progress: 0 };
    const uploading = uploadReducer([task], { type: 'progress', id: task.id, uploadedBytes: 3, totalBytes: 5 });
    expect(uploading[0]).toMatchObject({ status: 'uploading', uploadedBytes: 3, progress: 60 });
    const failed = uploadReducer(uploading, { type: 'failed', id: task.id, error: 'Upload failed' });
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'Upload failed' });
  });

  it('never starts more than two transports concurrently', async () => {
    let active = 0;
    let maximum = 0;
    const resolvers: Array<() => void> = [];
    const transport = vi.fn(() => new Promise<void>((resolve) => {
      active += 1;
      maximum = Math.max(maximum, active);
      resolvers.push(() => { active -= 1; resolve(); });
    }));
    const { result } = renderHook(() => useUploadQueue({ transport, onCompleted: () => undefined }));
    act(() => result.current.enqueue('root', [new File(['1'], '1.txt'), new File(['2'], '2.txt'), new File(['3'], '3.txt')]));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    act(() => resolvers.shift()?.());
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:ui -- tests/ui/uploads.test.tsx
```

Expected: FAIL because upload modules do not exist.

- [ ] **Step 3: Implement the XHR transport**

Create `uploadFileWithProgress` in `src/ui/api/uploads.ts`:

```ts
export function uploadFileWithProgress(input: {
  id: string;
  parentId: string;
  file: File;
  signal: AbortSignal;
  onProgress(uploadedBytes: number, totalBytes: number): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ parentId: input.parentId, name: input.file.name });
    xhr.open('PUT', `/api/admin/files/${encodeURIComponent(input.id)}?${query}`);
    xhr.setRequestHeader('content-type', input.file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => input.onProgress(event.loaded, event.total || input.file.size);
    xhr.onerror = () => reject(new Error('Network upload failed'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        try {
          const payload = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          reject(new Error(payload.error?.message || `Upload failed with ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed with ${xhr.status}`));
        }
      }
    };
    input.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(input.file);
  });
}
```

- [ ] **Step 4: Implement reducer and queue scheduling**

Define `UploadTask.status` as `queued | uploading | completed | failed | cancelled`. The reducer handles `enqueue`, `started`, `progress`, `completed`, `failed`, `cancelled`, `retry`, and `remove` actions without mutating arrays.

`useUploadQueue` stores one `AbortController` per running task, starts work in an effect while running count is below 2, uses `crypto.randomUUID()` for IDs, preserves the same ID on retry, and invokes `onCompleted(parentId)` after a task completes.

- [ ] **Step 5: Build the task panel and drag/drop entry points**

`UploadPanel` is rendered only when tasks exist and supports collapse, cancel, retry, remove completed, and clear completed. `UploadTaskRow` displays file name, progress bar, percentage, uploaded/total size, status, and one relevant action.

`ExplorerToolbar` contains a visible Upload command for admins and a hidden multiple-file input. The file surface accepts drag events only for admins, applies a stable drag-over state, and queues dropped files into `directory.current.id`. Completed uploads refresh only when their parent ID equals the current directory ID.

- [ ] **Step 6: Run tests and commit**

```bash
npm run test:ui -- tests/ui/uploads.test.tsx
npm run check
```

Expected: progress, retry state, and concurrency tests pass.

```bash
git add src/ui/api/uploads.ts src/ui/features/uploads src/ui/features/explorer/ExplorerToolbar.tsx src/ui/app/ExplorerApp.tsx tests/ui/uploads.test.tsx
git commit -m "feat: add upload task queue"
```

---

### Task 13: Complete Mobile Operations, Keyboard Behavior, and Functional States

**Files:**
- Create: `src/ui/features/explorer/MobileActionSheet.tsx`
- Modify: `src/ui/features/explorer/EntryActionMenu.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Modify: `src/ui/styles.css`
- Modify: `src/ui/main.tsx`
- Modify: `tests/ui/setup.ts`
- Create: `tests/ui/responsive-and-accessibility.test.tsx`

**Interfaces:**
- Consumes: shared entry actions and all explorer states.
- Produces: bottom-sheet mobile actions, full-screen mobile preview, keyboard closure, skip link, stable focus, and layouts that do not overlap at 390px or 1440px.

- [ ] **Step 1: Write failing behavior tests**

Create `tests/ui/responsive-and-accessibility.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileActionSheet } from '../../src/ui/features/explorer/MobileActionSheet';

describe('responsive actions', () => {
  it('exposes the same actions in a labeled mobile dialog and closes on Escape', () => {
    const onClose = vi.fn();
    render(<MobileActionSheet open title="Actions for report.pdf" actions={[{ id: 'download', label: 'Download', onSelect: () => undefined }]} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Actions for report.pdf' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:ui -- tests/ui/responsive-and-accessibility.test.tsx
```

Expected: FAIL because `MobileActionSheet` does not exist.

- [ ] **Step 3: Implement shared desktop/mobile actions**

Use one `EntryAction[]` array for both `EntryActionMenu` and `MobileActionSheet`. Select the presentation with a `(max-width: 760px)` media query listener. The sheet uses `role="dialog"`, a backdrop, 44px minimum action targets, Escape/outside-close behavior, and returns focus to the triggering ellipsis button.

Add a deterministic `matchMedia` mock to `tests/ui/setup.ts`:

```ts
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
```

- [ ] **Step 4: Complete the functional responsive CSS**

At `max-width: 760px`:

- Reduce page padding to 12px.
- Hide modified-time and status columns but preserve size under the file name.
- Keep one stable row grid with checkbox, icon, text, and action button.
- Use two grid columns above 480px and one below 480px.
- Make preview fixed to the full dynamic viewport.
- Make operation dialogs full-width sheets where appropriate.
- Keep file names constrained with ellipsis and title attributes.

At desktop widths, keep the centered 1080px surface and no permanent sidebar. Add `prefers-reduced-motion` handling and preserve existing dark-mode support without redesigning the palette.

- [ ] **Step 5: Add navigation and focus affordances**

Add a hidden “Skip to files” link before the top bar, a stable `id="file-list"` on the file surface, visible `:focus-visible` rings, `aria-live="polite"` on upload and operation summaries, and button labels for every icon-only command.

- [ ] **Step 6: Run tests, build, and commit**

```bash
npm run test:ui -- tests/ui/responsive-and-accessibility.test.tsx
npm run check
```

Expected: mobile action and accessibility tests pass; production build succeeds.

```bash
git add src/ui/features/explorer src/ui/app/ExplorerApp.tsx src/ui/main.tsx src/ui/styles.css tests/ui/setup.ts tests/ui/responsive-and-accessibility.test.tsx
git commit -m "feat: complete responsive explorer behavior"
```

---

### Task 14: Remove Superseded UI Code, Document Migration, and Verify Rollout

**Files:**
- Delete: `src/ui/api.ts`
- Delete: `src/ui/types.ts`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/db.ts`
- Modify: `src/worker/r2.ts`
- Modify: `src/worker/router.ts`
- Modify: `README.md`
- Modify: `.gitignore`
- Test: all Worker and UI suites

**Interfaces:**
- Consumes: completed Worker and React application.
- Produces: clean source tree, operator instructions, verified local migration, and a controlled production rollout with the old table retained.

- [ ] **Step 1: Prove the old UI modules are unused**

Run:

```bash
rg -n "from './api'|from './types'|getPublicTree|getAdminTree|uploadObject|patchObject" src/ui
```

Expected: no imports from the old flat modules remain.

- [ ] **Step 2: Delete superseded modules and check imports**

Delete `src/ui/api.ts` and `src/ui/types.ts`. Remove the old `ObjectRow`, `DirectoryEntry`, `FileEntry`, and `TreeResponse` types plus path-based object CRUD/stream helpers that no route imports. Keep the `objects` table and migration command; legacy file redirects resolve the decoded old key through `findEntryByStorageKey()`.

Run:

```bash
npx tsc --noEmit
```

Expected: no missing imports.

- [ ] **Step 3: Update operator documentation**

Update `README.md` with:

- The D1 virtual filesystem/R2 blob architecture.
- Local commands: apply migrations, run legacy import twice, run tests, start Worker.
- New read/admin API routes and stable file URL.
- Reserved root names.
- Upload request-size limitation.
- Recursive delete default limit of 1000 entries.
- Explicit statement that `objects` remains for one compatibility release.
- Production sequence: export D1, apply migration, import, verify counts, deploy, smoke-test.

Ensure `.superpowers/` remains ignored and do not add backup exports to the repository.

- [ ] **Step 4: Run complete automated verification**

```bash
npm run test
npm run check
npx wrangler d1 migrations apply ilist-db --local
npm run migrate:objects -- --local
npm run migrate:objects -- --local
npx wrangler d1 execute ilist-db --local --command "SELECT kind, status, COUNT(*) AS count FROM entries GROUP BY kind, status"
```

Expected: all tests/builds pass, migration/import commands are idempotent, and all imported entries are `ready`.

- [ ] **Step 5: Run local browser smoke tests**

Start:

```bash
npm run dev
```

Verify at desktop 1440x900 and mobile 390x844:

1. Root and nested URL refresh correctly.
2. Folder click navigates and browser Back returns.
3. File click opens preview and Back closes it.
4. Guest cannot see or fetch hidden entries.
5. Admin login reveals management commands in place.
6. Upload progress moves from queued to completed.
7. Empty folder, rename, move, visibility, recursive delete, and partial-result messages work.
8. No UI text overlaps, file names truncate safely, and action sheets fit the viewport.

Expected: browser console contains no uncaught errors.

- [ ] **Step 6: Commit cleanup and documentation**

```bash
git add -A src/ui src/worker README.md .gitignore
git commit -m "docs: document filesystem migration and rollout"
```

- [ ] **Step 7: Export and migrate production only after an explicit deployment checkpoint**

Run after confirming Cloudflare credentials and deployment intent:

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-entries.sql
npx wrangler d1 migrations apply ilist-db --remote
npm run migrate:objects -- --remote
npx wrangler d1 execute ilist-db --remote --command "SELECT kind, status, COUNT(*) AS count FROM entries GROUP BY kind, status"
npx wrangler d1 execute ilist-db --remote --command "SELECT COUNT(*) AS old_count FROM objects"
```

Expected: export succeeds, migration applies once, imported entry counts are plausible relative to old objects, and no old table is dropped.

- [ ] **Step 8: Deploy and run online smoke tests**

```bash
npm run deploy
```

Verify the deployed URL with:

```bash
curl -i 'https://ilist.chius.workers.dev/api/fs/list?path=/'
curl -i https://ilist.chius.workers.dev/api/admin/me
```

Expected: public list returns 200 and a structured directory response; unauthenticated `me` returns 401 with `AUTH_REQUIRED`. Then repeat the browser smoke paths from Step 5 against production, including one small disposable upload followed by deletion.

- [ ] **Step 9: Record the release result**

Append the deployed Worker version ID, migration count summary, smoke-test result, and known upload-size limitation to the implementation handoff message. Do not commit credentials, database exports, temporary test files, or the disposable upload.

---

## Plan Completion Criteria

- Existing R2 objects are represented by stable D1 entries without being copied.
- Guests and administrators use one URL-driven file explorer.
- Empty folders, true rename, move, visibility, upload, preview, stable download, recursive delete, and batch operations work.
- Old file links remain compatible for the migration release; old path-based mutation APIs are removed.
- Worker, D1/R2 integration, React interaction, responsive, build, local smoke, and production smoke checks pass.
- Visual refinement remains a separate follow-up after functional acceptance.
