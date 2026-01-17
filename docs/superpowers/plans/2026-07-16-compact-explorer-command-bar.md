# Compact Explorer Command Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate breadcrumb, toolbar, and refresh rows with one stable command bar containing a left path index and compact right-side controls.

**Architecture:** `ExplorerToolbar` becomes the command-bar owner and composes `Breadcrumbs` in its flexible left region. It manages transient search and mobile administrator-menu state while `ExplorerPage` continues to own directory/query/view data. CSS media queries switch the desktop segmented view and direct administrator actions to compact mobile controls without changing data behavior.

**Tech Stack:** React 19, TypeScript, Lucide React, CSS, Vitest, Testing Library, Playwright.

## Global Constraints

- The command bar is one row at every supported viewport.
- The left path index is the only left-aligned region; all commands are right-aligned.
- Command order is search, sort field, sort direction, refresh, and view mode.
- The root index renders only a home icon, never the `ilist` label.
- Search expands left over the path region without moving right-side controls.
- Mobile icon controls are at least 48px square.
- Mobile view mode is one toggle button and administrator upload/create-folder actions live in a `+` menu.
- Directory loading, filtering, sorting, retry, upload, and create-folder semantics remain unchanged.

---

### Task 1: Command Bar Composition and Search Behavior

**Files:**
- Modify: `src/ui/features/explorer/ExplorerToolbar.tsx`
- Modify: `src/ui/features/explorer/Breadcrumbs.tsx`
- Modify: `src/ui/app/ExplorerPage.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Test: `tests/ui/explorer.test.tsx`

**Interfaces:**
- Consumes: existing `Breadcrumb[]`, directory `refresh(): void`, and `loading: boolean`.
- Produces: `ExplorerToolbarProps` additions `breadcrumbs: Breadcrumb[]`, `onOpenPath(path: string): void`, `refreshing: boolean`, and `onRefresh(): void`.

- [ ] **Step 1: Write failing composition and interaction tests**

Add assertions that the path navigation is inside the file-controls region, the root button has accessible name `Path home` without visible `ilist`, controls occur in the required DOM order, clicking `Search` reveals and focuses the input, Escape closes it and restores focus, and `Refresh` invokes the directory request while disabled during loading.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/explorer.test.tsx`

Expected: failures because path and controls are separate and search is permanently expanded.

- [ ] **Step 3: Implement the combined toolbar**

Update the toolbar contract:

```ts
interface ExplorerToolbarProps {
  breadcrumbs: Breadcrumb[];
  refreshing: boolean;
  onOpenPath(path: string): void;
  onRefresh(): void;
  // retain existing query, sort, view, session, capability, and action props
}
```

Compose `<Breadcrumbs />` as the first toolbar child. Add `searchOpen`, a search-button ref, an input ref, outside-click handling, and Escape handling. Render `Search`, compact sort select, sort direction, `RefreshCw`, then view controls. Give the refresh icon a `isSpinning` class while `refreshing` is true.

Change root breadcrumb content to:

```tsx
<button type="button" aria-label={t('explorer.pathHome')} onClick={() => onOpen(item.path)}>
  <Home aria-hidden="true" size={15} />
</button>
```

Add localized `explorer.pathHome`, mobile view-switch labels, and the mobile administrator-menu label to both English and Chinese message maps.

Move breadcrumbs and refresh props from `ExplorerPage`, then remove the standalone breadcrumb and `.directoryCommands` markup.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/explorer.test.tsx`

Expected: all explorer tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/ui/features/explorer/ExplorerToolbar.tsx src/ui/features/explorer/Breadcrumbs.tsx src/ui/app/ExplorerPage.tsx src/ui/i18n/messages.ts tests/ui/explorer.test.tsx
git commit -m "feat: combine explorer command bar"
```

### Task 2: Responsive Controls and Mobile Administrator Menu

**Files:**
- Modify: `src/ui/features/explorer/ExplorerToolbar.tsx`
- Modify: `src/ui/styles/explorer.css`
- Test: `tests/ui/responsive-and-accessibility.test.tsx`
- Test: `tests/ui/style-contracts.test.ts`

**Interfaces:**
- Consumes: Task 1 `ExplorerToolbarProps` and existing upload/create/view callbacks.
- Produces: desktop `.desktopViewToggle`/`.desktopAdminActions`, mobile `.mobileViewToggle`/`.mobileAdminActions`, and `.searchOverlay` responsive contracts.

- [ ] **Step 1: Write failing responsive tests**

Test a mobile `matchMedia` result and assert that one view-toggle button changes modes, the `+` button opens a labeled menu containing Upload and Create folder, each command invokes the existing callback, and Escape/outside click closes the menu. Add style-contract assertions for a 48px mobile target, a one-row toolbar, compact sort width, and removal of `.directoryCommands`.

- [ ] **Step 2: Run responsive tests and verify RED**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/responsive-and-accessibility.test.tsx tests/ui/style-contracts.test.ts`

Expected: failures because mobile-specific controls and command-bar CSS do not exist.

- [ ] **Step 3: Implement responsive rendering and CSS**

Render desktop and mobile variants with CSS visibility classes. The mobile view button calls:

```ts
onView(view === 'list' ? 'grid' : 'list');
```

The mobile administrator menu uses a controlled `<details>`-style or popover-like menu with Upload and Create folder buttons, closes before invoking commands, and preserves accessible labels.

Replace separate breadcrumb/toolbar CSS with a fixed single-row layout:

```css
.explorerToolbar { position: relative; display: flex; align-items: center; min-height: 54px; }
.toolbarPath { min-width: 0; flex: 1 1 auto; overflow: hidden; }
.toolbarActions { position: relative; z-index: 2; margin-left: auto; }
.searchOverlay { position: absolute; right: 100%; width: min(360px, calc(100vw - 24px)); }
.sortControl select { width: auto; max-width: 88px; }
```

At `max-width: 760px`, hide desktop variants, show mobile variants, make icon controls 48px square, truncate the path, and let the search overlay cover the left region without moving `.toolbarActions`.

- [ ] **Step 4: Run responsive tests and verify GREEN**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/responsive-and-accessibility.test.tsx tests/ui/style-contracts.test.ts`

Expected: all responsive and style-contract tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/ui/features/explorer/ExplorerToolbar.tsx src/ui/styles/explorer.css tests/ui/responsive-and-accessibility.test.tsx tests/ui/style-contracts.test.ts
git commit -m "feat: add responsive command controls"
```

### Task 3: Visual Regression, Full Verification, and Deployment

**Files:**
- Modify: `tests/e2e/web-ui.spec.ts`
- Modify: `tests/e2e/web-ui.spec.ts-snapshots/*.png`

**Interfaces:**
- Consumes: completed command bar and existing Playwright fixture routes.
- Produces: stable desktop, tablet, and mobile baselines for collapsed search, expanded search, and mobile administrator menu.

- [ ] **Step 1: Extend browser assertions**

Assert the root text `ilist` is absent from the path, the command order is stable, expanded search does not move the refresh/view controls, mobile exposes one view toggle, and the administrator `+` menu contains both commands.

- [ ] **Step 2: Update and inspect visual baselines**

Run: `PLAYWRIGHT_BROWSER_CHANNEL=chrome npm run test:visual -- --update-snapshots`

Expected: 15 Playwright scenarios pass. Inspect desktop, tablet, and mobile explorer screenshots plus expanded-search and administrator-menu states for clipping, overlap, and wrapping.

- [ ] **Step 3: Run complete verification**

Run: `npm run check`

Expected: TypeScript, Vite production build, 177 Worker tests, and all UI tests pass.

Run: `PLAYWRIGHT_BROWSER_CHANNEL=chrome npm run test:e2e`

Expected: all 15 browser scenarios pass.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Commit visual coverage**

```bash
git add tests/e2e/web-ui.spec.ts tests/e2e/web-ui.spec.ts-snapshots
git commit -m "test: cover compact explorer command bar"
```

- [ ] **Step 5: Push and deploy after a clean worktree**

Run: `git push origin main`

Run: `npm run deploy`

Expected: Wrangler reports a new Worker version for `https://ilist.chius.workers.dev`.
