# ilist Web UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the provisional ilist frontend with the approved OpenList-inspired, bilingual, responsive graphite-and-orange interface while preserving all existing Worker APIs and storage behavior.

**Architecture:** Keep React, Vite, Lucide, the existing API modules, and feature-level domain hooks. Add typed preference and localization providers at the application boundary, split explorer orchestration into a shared shell plus explorer and administration pages, and migrate the single stylesheet into semantic feature styles. Remote state remains in the existing hooks; only frontend preferences use browser storage.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Lucide React, Vitest, Testing Library, Playwright, Cloudflare Workers Assets

## Global Constraints

- Node.js 22.12 or newer and npm 10 or newer.
- Do not change Worker routes, D1 migrations, storage drivers, OAuth, authentication semantics, or upload transports.
- Do not add a UI framework, CSS framework, localization framework, or global server-state library.
- Preserve single-click folder-open and file-preview behavior.
- Support exactly `en` and `zh-CN`; every visible application string must exist in both dictionaries.
- Initial locale follows the browser and initial theme follows the system; both remain manually overridable.
- Desktop list rows target 36px; mobile interactive rows provide at least 48px touch targets.
- Use neutral graphite with restrained Cloudflare orange in complete light and dark themes.
- Keep letter spacing at `0`; do not scale fonts with viewport width.
- Preserve focus rings, the skip link, semantic landmarks, focus restoration, and reduced-motion support.
- Browser verification viewports are 1440x900, 834x1112, and 390x844.
- Every task ends with `npm run check` passing before commit.

---

## File Structure

```text
src/ui/
  app/
    AppProviders.tsx
    AppShell.tsx
    AdminLayout.tsx
    ExplorerApp.tsx
    ExplorerPage.tsx
    PreferencesPage.tsx
  i18n/
    messages.ts
    I18nProvider.tsx
  preferences/
    preferences.ts
    PreferencesProvider.tsx
  components/
    AppHeader.tsx
    ToastRegion.tsx
  features/explorer/
    ExplorerCollection.tsx
    FileIcon.tsx
  styles/
    tokens.css
    base.css
    shell.css
    explorer.css
    overlays.css
    admin.css
    responsive.css
tests/ui/
  preferences-and-i18n.test.tsx
  shell.test.tsx
  collection-interactions.test.tsx
  states-and-feedback.test.tsx
  admin-layout.test.tsx
tests/e2e/
  fixtures.ts
  web-ui.spec.ts
playwright.config.ts
```

Delete `src/ui/styles.css` only after all rules move into the new feature styles in Task 6.

---

### Task 1: Typed Preferences and Localization Foundation

**Files:**
- Create: `src/ui/preferences/preferences.ts`
- Create: `src/ui/preferences/PreferencesProvider.tsx`
- Create: `src/ui/i18n/messages.ts`
- Create: `src/ui/i18n/I18nProvider.tsx`
- Create: `src/ui/app/AppProviders.tsx`
- Create: `tests/ui/preferences-and-i18n.test.tsx`
- Modify: `src/ui/App.tsx`

**Interfaces:**
- Produces `Locale`, `ThemePreference`, `UiPreferences`, `readPreferences()`, `writePreferences()`, `PreferencesProvider`, and `usePreferences()`.
- Produces `MessageKey`, `I18nProvider`, and `useI18n()` returning `{ locale, t, formatBytes, formatDate, formatNumber }`.
- Persists one versioned key: `ilist.ui.preferences`.
- Later tasks must not access `localStorage` directly.

- [ ] **Step 1: Write failing preference and dictionary tests**

```tsx
function Probe() {
  const { preferences, updatePreferences } = usePreferences();
  const { t } = useI18n();
  return <>
    <span>{t('nav.files')}</span>
    <span data-testid="theme">{preferences.theme}</span>
    <button onClick={() => updatePreferences({ locale: 'zh-CN', theme: 'dark' })}>change</button>
  </>;
}

it('keeps dictionaries identical and persists valid changes', async () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  render(<AppProviders><Probe /></AppProviders>);
  await userEvent.click(screen.getByRole('button', { name: 'change' }));
  expect(screen.getByText('文件')).toBeVisible();
  expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(JSON.parse(localStorage.getItem('ilist.ui.preferences')!)).toMatchObject({ version: 1, locale: 'zh-CN', theme: 'dark' });
});

it('falls back when saved preferences are invalid', () => {
  localStorage.setItem('ilist.ui.preferences', '{"version":99,"locale":"bad"}');
  render(<AppProviders><Probe /></AppProviders>);
  expect(screen.getByTestId('theme')).toHaveTextContent('system');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/preferences-and-i18n.test.tsx`

Expected: FAIL because the new providers and dictionaries do not exist.

- [ ] **Step 3: Implement schema parsing and persistence**

```ts
export const PREFERENCES_KEY = 'ilist.ui.preferences';
export type Locale = 'en' | 'zh-CN';
export type ThemePreference = 'system' | 'light' | 'dark';
export type ExplorerViewPreference = 'list' | 'grid';
export interface UiPreferences { version: 1; locale: Locale; theme: ThemePreference; defaultView: ExplorerViewPreference; }

export function defaultPreferences(): UiPreferences {
  return { version: 1, locale: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', theme: 'system', defaultView: 'list' };
}

export function readPreferences(storage: Storage = window.localStorage): UiPreferences {
  try {
    const value = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? 'null') as Partial<UiPreferences> | null;
    if (value?.version !== 1 || !['en', 'zh-CN'].includes(value.locale ?? '') || !['system', 'light', 'dark'].includes(value.theme ?? '') || !['list', 'grid'].includes(value.defaultView ?? '')) return defaultPreferences();
    return value as UiPreferences;
  } catch { return defaultPreferences(); }
}

export function writePreferences(value: UiPreferences, storage: Storage = window.localStorage): void {
  try { storage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch { /* browser storage can be unavailable */ }
}
```

`PreferencesProvider` exposes `updatePreferences(patch)` and listens to `matchMedia('(prefers-color-scheme: dark)')`. It updates `document.documentElement.lang` and the resolved `data-theme` after every preference or system-theme change.

- [ ] **Step 4: Implement typed dictionaries and formatters**

Create matching `en` and `zhCN` records. Start with namespaces `nav`, `toolbar`, `selection`, `entry`, `action`, `state`, `admin`, `preference`, and `common`. Define `MessageKey = keyof typeof en`; type `zhCN` as `Record<MessageKey, string>`. Implement placeholder replacement for `{name}` and `{count}`, plus locale-aware byte, date, number, and count formatting using `Intl`.

Required initial keys include:

```ts
export const en = {
  'nav.files': 'Files', 'nav.storage': 'Storage', 'nav.appearance': 'Appearance',
  'nav.signIn': 'Admin sign in', 'nav.signOut': 'Sign out',
  'toolbar.search': 'Search this folder', 'toolbar.upload': 'Upload files', 'toolbar.createFolder': 'Create folder',
  'toolbar.sort': 'Sort files', 'toolbar.list': 'List view', 'toolbar.grid': 'Grid view',
  'selection.count': '{count} selected', 'selection.clear': 'Clear selection',
  'entry.folder': 'Folder', 'entry.file': 'File', 'entry.actions': 'Actions for {name}',
  'action.open': 'Open', 'action.preview': 'Preview', 'action.download': 'Download', 'action.copyLink': 'Copy link',
  'action.rename': 'Rename', 'action.move': 'Move', 'action.properties': 'Properties', 'action.publish': 'Publish',
  'action.hide': 'Hide', 'action.delete': 'Delete', 'action.cancel': 'Cancel', 'action.retry': 'Retry',
  'state.loadingFiles': 'Loading files', 'state.refreshing': 'Refreshing', 'state.empty': 'This folder is empty',
  'state.noResults': 'No matching items', 'state.loadFailed': 'Unable to load this folder',
  'admin.storageTitle': 'Storage mounts', 'admin.addStorage': 'Add storage', 'admin.appearanceTitle': 'Appearance',
  'preference.language': 'Language', 'preference.theme': 'Theme', 'preference.defaultView': 'Default view',
  'common.close': 'Close', 'common.save': 'Save', 'common.enabled': 'Enabled', 'common.disabled': 'Disabled',
} as const;
```

- [ ] **Step 5: Compose providers**

```tsx
export function AppProviders({ children }: PropsWithChildren) {
  return <PreferencesProvider><I18nProvider>{children}</I18nProvider></PreferencesProvider>;
}

export function App() {
  return <AppProviders><ExplorerApp /></AppProviders>;
}
```

- [ ] **Step 6: Verify and commit**

Run focused test, then `npm run check`. Expected: PASS.

```bash
git add src/ui/preferences src/ui/i18n src/ui/app/AppProviders.tsx src/ui/App.tsx tests/ui/preferences-and-i18n.test.tsx
git commit -m "feat: add ui preferences and localization"
```

---

### Task 2: Semantic Tokens and Shared Application Shell

**Files:**
- Create: `src/ui/styles/tokens.css`
- Create: `src/ui/styles/base.css`
- Create: `src/ui/styles/shell.css`
- Create: `src/ui/components/AppHeader.tsx`
- Create: `src/ui/app/AppShell.tsx`
- Create: `tests/ui/shell.test.tsx`
- Modify: `src/ui/main.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`

**Interfaces:**
- Consumes `usePreferences()`, `useI18n()`, and current session state.
- Produces `AppShell({ children, admin, username, contentId, onHome, onStorage, onSignIn, onSignOut })`.
- Produces semantic CSS variables consumed by later feature styles.

- [ ] **Step 1: Write failing shell tests**

```tsx
it('renders stable language, theme, and account controls', async () => {
  render(<App />);
  expect(await screen.findByRole('banner')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Open ilist root' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Change language' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Change theme' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Admin sign in' })).toBeVisible();
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/shell.test.tsx`

Expected: FAIL because the shell controls do not exist.

- [ ] **Step 3: Define light and dark tokens**

```css
:root {
  color-scheme: light;
  --color-page: #f2f2f1; --color-surface: #ffffff; --color-surface-raised: #ffffff;
  --color-surface-muted: #faf9f7; --color-hover: #f7f3f0; --color-selected: #fff0e9;
  --color-text: #282726; --color-muted: #746f6a; --color-border: #e4e0dc; --color-border-strong: #cbc5bf;
  --color-primary: #d96037; --color-primary-hover: #bd4d29; --color-primary-text: #ffffff;
  --color-danger: #b53a43; --color-success: #2d7a54; --focus-ring: 0 0 0 3px rgb(217 96 55 / 28%);
  --shadow-raised: 0 12px 30px rgb(64 47 39 / 12%); --radius-control: 5px; --radius-panel: 7px;
  --control-size: 36px; --layer-header: 10; --layer-menu: 30; --layer-overlay: 40; --layer-toast: 50;
}
[data-theme='dark'] {
  color-scheme: dark;
  --color-page: #171716; --color-surface: #201f1e; --color-surface-raised: #292725;
  --color-surface-muted: #242321; --color-hover: #302d2a; --color-selected: #41291f;
  --color-text: #f1efec; --color-muted: #b0aaa3; --color-border: #3b3834; --color-border-strong: #55504a;
  --color-primary: #ef7b50; --color-primary-hover: #ff9168; --shadow-raised: 0 14px 34px rgb(0 0 0 / 32%);
}
```

Move reset, typography, `.srOnly`, `.skipLink`, shared controls, focus, and reduced-motion baseline into `base.css`.

- [ ] **Step 4: Implement header and shell**

```tsx
export interface AppShellProps extends PropsWithChildren {
  admin: boolean;
  username?: string;
  contentId: string;
  onHome(): void;
  onStorage(): void;
  onSignIn(): void;
  onSignOut(): void | Promise<void>;
}
```

Use stable 36px controls, accessible names, and tooltips. `AppShell` renders the skip link, header, and page outlet without changing current routing.

- [ ] **Step 5: Layer styles and remove duplicate shell rules**

```ts
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles.css';
```

Delete only rules already migrated; leave feature styles for later tasks.

- [ ] **Step 6: Verify and commit**

Run shell and location/session tests, then `npm run check`. Expected: PASS.

```bash
git add src/ui/styles src/ui/components/AppHeader.tsx src/ui/app/AppShell.tsx src/ui/main.tsx src/ui/app/ExplorerApp.tsx tests/ui/shell.test.tsx
git commit -m "feat: add redesigned application shell"
```

---

### Task 3: Explorer Page and Responsive File Surface

**Files:**
- Create: `src/ui/app/ExplorerPage.tsx`
- Create: `src/ui/features/explorer/ExplorerCollection.tsx`
- Create: `src/ui/features/explorer/FileIcon.tsx`
- Create: `src/ui/styles/explorer.css`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Modify: `src/ui/features/explorer/Breadcrumbs.tsx`
- Modify: `src/ui/features/explorer/ExplorerToolbar.tsx`
- Modify: `src/ui/features/explorer/SelectionToolbar.tsx`
- Modify: `src/ui/features/explorer/FileList.tsx`
- Modify: `src/ui/features/explorer/EntryRow.tsx`
- Modify: `src/ui/features/explorer/FileGrid.tsx`
- Modify: `src/ui/features/explorer/EmptyState.tsx`
- Modify: `src/ui/main.tsx`
- Modify: `tests/ui/explorer.test.tsx`
- Modify: `tests/ui/responsive-and-accessibility.test.tsx`

**Interfaces:**
- Consumes unchanged directory, entry, session, upload, and operation APIs.
- Produces `ExplorerPage` with current directory and file-operation orchestration.
- Produces `ExplorerCollection({ view, entries, selectedIds, admin, handlers })`.
- Produces shared `FileIcon({ entry, size })`.

- [ ] **Step 1: Write failing hierarchy tests**

```tsx
it('orders path, controls, and collection and keeps actions separate', async () => {
  render(<App />);
  const path = await screen.findByRole('navigation', { name: 'Path' });
  const controls = screen.getByRole('region', { name: 'File controls' });
  const files = screen.getByRole('list', { name: 'Files and folders' });
  expect(path.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(controls.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const open = screen.getByRole('button', { name: 'Open report.pdf' });
  expect(open).not.toContainElement(screen.getByRole('button', { name: 'Actions for report.pdf' }));
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run explorer and responsive tests. Expected: FAIL on new hierarchy and accessible open names.

- [ ] **Step 3: Move explorer orchestration into `ExplorerPage`**

Move directory, query, sort, view, selection, uploads, preview loading, menus, dialogs, drag/drop, and batch handling from `ExplorerApp`. Keep `ExplorerApp` responsible for session, URL state, previous non-admin path, and page selection.

```tsx
export interface ExplorerPageProps {
  path: string;
  previewId: string | null;
  session: ReturnType<typeof useSession>;
  onOpenPath(path: string): void;
  onOpenPreview(id: string): void;
  onClosePreview(): void;
  onRequestLogin(): void;
}
```

- [ ] **Step 4: Redesign path and toolbar without changing capabilities**

Use a constrained browser frame, path bar, and stable toolbar slot. Search remains local. Upload and create-folder retain existing capability checks. The selection toolbar occupies the same slot.

- [ ] **Step 5: Redesign list and grid with shared formatters**

List columns: checkbox, icon/name, modified, size, actions. Remove the MIME column from the list but keep MIME in properties and preview fallback. Grid cards use stable media and footer geometry. Replace local size/date formatters with `useI18n()`.

Remove `VIEW_MODE_KEY`, `storedViewMode()`, and `persistViewMode()` from `ExplorerApp`. Initialize the page view from `preferences.defaultView`; when the user switches list/grid mode, call `updatePreferences({ defaultView: nextView })` so one versioned preference object remains the only browser-storage source.

```tsx
export interface EntryHandlers {
  onOpen(entry: Entry): void;
  onPreview(entry: Entry): void;
  onToggle(entry: Entry, options?: { range?: boolean }): void;
  onMenu(entry: Entry, anchor?: HTMLElement): void;
}
```

- [ ] **Step 6: Add adaptive explorer styles**

Implement 36px desktop rows, 48px mobile rows, `minmax(0, 1fr)` name tracks, tabular metadata, radii no larger than 8px, and progressively hidden metadata. Grid tracks use `repeat(auto-fill, minmax(148px, 1fr))` and fixed media aspect ratios.

- [ ] **Step 7: Verify and commit**

Run explorer, location/session, responsive, preview, and upload tests, then `npm run check`. Expected: PASS.

```bash
git add src/ui/app/ExplorerApp.tsx src/ui/app/ExplorerPage.tsx src/ui/features/explorer src/ui/styles/explorer.css src/ui/main.tsx tests/ui/explorer.test.tsx tests/ui/responsive-and-accessibility.test.tsx
git commit -m "feat: redesign file explorer surface"
```

---

### Task 4: Selection, Keyboard, Context Menu, and Mobile Interaction

**Files:**
- Modify: `src/ui/hooks/useSelection.ts`
- Modify: `src/ui/features/explorer/ExplorerCollection.tsx`
- Modify: `src/ui/features/explorer/FileList.tsx`
- Modify: `src/ui/features/explorer/EntryRow.tsx`
- Modify: `src/ui/features/explorer/FileGrid.tsx`
- Modify: `src/ui/features/explorer/EntryActionMenu.tsx`
- Modify: `src/ui/features/explorer/MobileActionSheet.tsx`
- Modify: `src/ui/app/ExplorerPage.tsx`
- Create: `tests/ui/collection-interactions.test.tsx`

**Interfaces:**
- Extends `useSelection()` with `anchorId`, `toggle(id)`, `range(orderedIds, targetId)`, `selectAll(ids)`, `replace(ids)`, and `clear()`.
- `ExplorerCollection` owns roving focus, keyboard handling, and pointer marquee selection.
- Single click opens folders or previews files; selection remains explicit.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it('opens on single click without selecting', async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: 'Open Archive' }));
  expect(location.pathname).toBe('/Archive');
  expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
});

it('supports range selection and select all', async () => {
  render(<App />);
  const first = await screen.findByRole('checkbox', { name: 'Select first.txt' });
  const third = screen.getByRole('checkbox', { name: 'Select third.txt' });
  await userEvent.click(first);
  fireEvent.click(third, { shiftKey: true });
  expect(screen.getByText('3 selected')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('list', { name: 'Files and folders' }), { key: 'a', metaKey: true });
  expect(screen.getByText('4 selected')).toBeVisible();
});

it('uses roving focus and keyboard activation', async () => {
  render(<App />);
  const collection = await screen.findByRole('list', { name: 'Files and folders' });
  collection.focus();
  fireEvent.keyDown(collection, { key: 'ArrowDown' });
  fireEvent.keyDown(collection, { key: 'Enter' });
  expect(location.pathname).toBe('/Archive');
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/collection-interactions.test.tsx`

Expected: FAIL because range selection, roving focus, select-all, and marquee selection are absent.

- [ ] **Step 3: Implement anchored range selection**

```ts
const range = useCallback((orderedIds: string[], targetId: string) => {
  setState((current) => {
    const anchor = current.anchorId && orderedIds.includes(current.anchorId) ? current.anchorId : targetId;
    const start = orderedIds.indexOf(anchor);
    const end = orderedIds.indexOf(targetId);
    const next = new Set(current.selectedIds);
    for (const id of orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(id);
    return { selectedIds: next, anchorId: anchor };
  });
}, []);
```

Represent state as `{ selectedIds: Set<string>; anchorId: string | null }`. `toggle` updates the anchor and `clear` resets both. Pass only mutable visible IDs to range and select-all.

- [ ] **Step 4: Implement collection keyboard behavior**

Give `ExplorerCollection` `tabIndex={0}` and `aria-activedescendant`. Maintain `focusedId` while the entry remains visible. Implement Arrow keys, `Enter`, `Space`, `Ctrl/Cmd+A`, and `Escape`. Do not intercept shortcuts while focus is in an input, select, textarea, menu, or dialog.

- [ ] **Step 5: Implement desktop marquee selection**

Begin only from empty collection space with the primary pointer. Track a fixed-position rectangle through pointer events and compare it with elements carrying `data-entry-id` using `getBoundingClientRect()`. Update once per animation frame. Cancel on pointer cancellation, navigation, or `Escape`. Never start from rows, cards, checkboxes, links, or buttons.

- [ ] **Step 6: Anchor menus and preserve focus**

Pass the invoking element as the menu anchor, fit the desktop menu inside the viewport, and restore focus to the same element. Keep the mobile action sheet as the only small-screen action surface. Store action message keys, not translated labels, in action definitions.

- [ ] **Step 7: Verify and commit**

Run collection, operation, and accessibility tests, then `npm run check`. Expected: PASS.

```bash
git add src/ui/hooks/useSelection.ts src/ui/features/explorer src/ui/app/ExplorerPage.tsx tests/ui/collection-interactions.test.tsx
git commit -m "feat: complete explorer interaction model"
```

---

### Task 5: Unified Overlays, Feedback, and Page States

**Files:**
- Create: `src/ui/components/ToastRegion.tsx`
- Create: `src/ui/styles/overlays.css`
- Create: `tests/ui/states-and-feedback.test.tsx`
- Modify: `src/ui/app/ExplorerPage.tsx`
- Modify: `src/ui/features/explorer/LoginDialog.tsx`
- Modify: `src/ui/features/explorer/EmptyState.tsx`
- Modify: `src/ui/features/operations/DeleteDialog.tsx`
- Modify: `src/ui/features/operations/FolderPickerDialog.tsx`
- Modify: `src/ui/features/operations/PropertiesDialog.tsx`
- Modify: `src/ui/features/operations/RenameDialog.tsx`
- Modify: `src/ui/features/preview/PreviewOverlay.tsx`
- Modify: `src/ui/features/uploads/UploadPanel.tsx`
- Modify: `src/ui/features/uploads/UploadTaskRow.tsx`
- Modify: `src/ui/main.tsx`

**Interfaces:**
- Produces `ToastMessage { id, tone, message }` and `ToastRegion({ toasts, onDismiss })`.
- All overlays consume `useI18n()` and shared semantic styles.
- Mutation and upload APIs remain unchanged.

- [ ] **Step 1: Write failing feedback tests**

```tsx
it('keeps stale content visible during refresh', async () => {
  render(<App />);
  expect(await screen.findByText('report.pdf')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByText('report.pdf')).toBeVisible();
  expect(screen.getByRole('status', { name: 'Refreshing' })).toBeVisible();
});

it('keeps failed batch entries selected and announces counts', async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select first.txt' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select second.txt' }));
  await userEvent.click(screen.getByRole('button', { name: 'Hide selected' }));
  expect(await screen.findByRole('status')).toHaveTextContent('1 completed, 1 failed');
  expect(screen.getByRole('checkbox', { name: 'Select second.txt' })).toBeChecked();
});

it('offers download after preview failure', () => {
  const file: Entry = {
    id: 'file-report', parentId: 'root', name: 'report.pdf', kind: 'file', size: 2400,
    contentType: 'application/pdf', updatedAt: '2026-07-10T00:00:00Z', isPublic: true,
    effectivePublic: true, sortOrder: 0, description: '', mountPath: null,
    capabilities: { open: false, preview: true, download: true, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false },
  };
  render(<PreviewOverlay entry={file} error={new Error('Preview failed')} onClose={() => undefined} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Preview failed');
  expect(screen.getByRole('link', { name: 'Download report.pdf' })).toBeVisible();
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npx vitest run --config vitest.ui.config.ts tests/ui/states-and-feedback.test.tsx`

Expected: FAIL because refreshed, toast, and preview fallback states are incomplete.

- [ ] **Step 3: Implement a bounded accessible toast queue**

```ts
export type ToastTone = 'success' | 'error' | 'info';
export interface ToastMessage { id: string; tone: ToastTone; message: string; }
```

Keep at most four messages. Auto-dismiss success and info after five seconds; errors remain until dismissed. Render one fixed `aria-live="polite"` region, with individual errors using `role="alert"`. Replace `operationNotice` while retaining failed selection behavior.

- [ ] **Step 4: Standardize loading, empty, and error surfaces**

Create list/grid skeletons matching final geometry. Keep content mounted during refresh. Distinguish empty directory, no results, unavailable/private directory, disconnected storage, and load failure. Every recoverable error has one retry command.

- [ ] **Step 5: Standardize overlays and upload feedback**

Use shared scrim, header, body, footer, focus restoration, and mobile full-screen/bottom-sheet rules. Preview uses a stable header and download fallback. Upload rows retain progress, cancellation, retry, completion, and removal without resizing the panel header.

- [ ] **Step 6: Preserve login username and localize touched strings**

Reset login fields only after close or successful login. Preserve username after failure. Translate labels, busy states, errors, tooltips, media fallbacks, dialog copy, and upload statuses; add identical keys to both dictionaries.

- [ ] **Step 7: Verify and commit**

Run feedback, preview, upload, operation, and session tests, then `npm run check`. Expected: PASS.

```bash
git add src/ui/components/ToastRegion.tsx src/ui/styles/overlays.css src/ui/app/ExplorerPage.tsx src/ui/features tests/ui/states-and-feedback.test.tsx src/ui/main.tsx
git commit -m "feat: unify frontend feedback states"
```

---

### Task 6: OpenList-Style Administration and Appearance Preferences

**Files:**
- Create: `src/ui/app/AdminLayout.tsx`
- Create: `src/ui/app/PreferencesPage.tsx`
- Create: `src/ui/styles/admin.css`
- Create: `src/ui/styles/responsive.css`
- Create: `tests/ui/admin-layout.test.tsx`
- Modify: `src/ui/app/ExplorerApp.tsx`
- Modify: `src/ui/features/mounts/MountManager.tsx`
- Modify: `src/ui/features/mounts/MountDialog.tsx`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `src/ui/main.tsx`
- Modify: `tests/ui/mounts.test.tsx`
- Delete: `src/ui/styles.css`

**Interfaces:**
- `AdminLayout({ active, onNavigate, onBack, children })` supports `active: 'storage' | 'appearance'`.
- `PreferencesPage` uses only preference and i18n contexts.
- `MountManager` retains all current API calls.

- [ ] **Step 1: Write failing administration tests**

```tsx
it('navigates between storage, appearance, and files', async () => {
  history.replaceState(null, '', '/admin/storages');
  render(<App />);
  expect(await screen.findByRole('navigation', { name: 'Administration' })).toBeVisible();
  await userEvent.click(screen.getByRole('link', { name: 'Appearance' }));
  expect(location.pathname).toBe('/admin/appearance');
  expect(screen.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await userEvent.click(screen.getByRole('link', { name: 'Files' }));
  expect(location.pathname).toBe('/');
});

it('updates local preferences without an API request', async () => {
  history.replaceState(null, '', '/admin/appearance');
  render(<App />);
  await userEvent.selectOptions(await screen.findByLabelText('Language'), 'zh-CN');
  expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('settings'), expect.anything());
});

it('renders mounts as one semantic table', async () => {
  history.replaceState(null, '', '/admin/storages');
  render(<App />);
  const table = await screen.findByRole('table', { name: 'Storage mounts' });
  expect(within(table).getByText('/archive')).toBeVisible();
  expect(within(table).getByText('Cloudflare R2')).toBeVisible();
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run admin-layout and mount tests. Expected: FAIL because appearance routing, admin navigation, and table semantics are absent.

- [ ] **Step 3: Implement administration routing and layout**

Recognize `/admin/storages` and `/admin/appearance`. Keep the last non-admin path. Collapse the sidebar to a drawer on mobile. Continue using the existing History API store; do not add React Router.

```tsx
export type AdminSection = 'storage' | 'appearance';
export interface AdminLayoutProps extends PropsWithChildren {
  active: AdminSection;
  onNavigate(section: AdminSection): void;
  onBack(): void;
}
```

- [ ] **Step 4: Convert mounts to a responsive table**

Desktop columns: name/provider, mount path, connection, enabled state, actions. Tablet places provider below name. Mobile uses an unframed stacked record while preserving all information and one action menu. Keep existing connect, disconnect, test, toggle, edit, and delete callbacks.

- [ ] **Step 5: Implement local appearance preferences**

Use segmented controls or selects for language (`en`, `zh-CN`), theme (`system`, `light`, `dark`), and default view (`list`, `grid`). Updates apply immediately. Reset writes `defaultPreferences()` and updates the document in the same render cycle.

- [ ] **Step 6: Complete stylesheet migration**

Import in this fixed order:

```ts
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/explorer.css';
import './styles/overlays.css';
import './styles/admin.css';
import './styles/responsive.css';
```

Delete `styles.css` only after `rg -n "styles\.css" src` returns no matches.

- [ ] **Step 7: Verify and commit**

Run admin, mount, session, and accessibility tests, then `npm run check`. Expected: PASS.

```bash
git add src/ui/app src/ui/features/mounts src/ui/styles src/ui/i18n/messages.ts src/ui/main.tsx tests/ui/admin-layout.test.tsx tests/ui/mounts.test.tsx
git rm src/ui/styles.css
git commit -m "feat: redesign storage administration"
```

---

### Task 7: Localization Audit, Playwright Coverage, and Documentation

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/fixtures.ts`
- Create: `tests/e2e/web-ui.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/ui/i18n/messages.ts`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `tests/ui/responsive-and-accessibility.test.tsx`

**Interfaces:**
- Adds dev dependency `@playwright/test`.
- Adds scripts `dev:web`, `test:e2e`, and `test:visual`.
- Browser fixtures intercept existing API routes; production Worker code remains unchanged.

- [ ] **Step 1: Add a failing visible-string audit**

```tsx
for (const locale of ['en', 'zh-CN'] as const) {
  it(`renders primary surfaces in ${locale}`, async () => {
    localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale, theme: 'light', defaultView: 'list' }));
    render(<App />);
    expect(await screen.findByRole('main')).toBeVisible();
    expect(screen.getByRole('button', { name: locale === 'en' ? 'Upload files' : '上传文件' })).toBeVisible();
  });
}
```

- [ ] **Step 2: Run audit and remove remaining hard-coded visible strings**

Run responsive/accessibility tests. Expected before fixes: FAIL on untranslated labels. Audit with `rg -n "[>\"'][A-Z][A-Za-z ]{2,}" src/ui --glob '*.tsx'`. Preserve product names, provider values, MIME types, paths, identifiers, and fixture file names.

- [ ] **Step 3: Install Playwright and add scripts**

Run: `npm install --save-dev @playwright/test`

```json
{
  "dev:web": "vite --host 127.0.0.1 --port 4173",
  "test:e2e": "playwright test",
  "test:visual": "playwright test --grep @visual"
}
```

Run: `npx playwright install chromium`. Expected: Chromium installs successfully.

- [ ] **Step 4: Configure deterministic browser tests**

```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev:web', url: 'http://127.0.0.1:4173', reuseExistingServer: true },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 834, height: 1112 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
```

Fixtures intercept `/api/admin/me`, `/api/fs/list`, `/api/fs/entries/*`, `/api/admin/mounts`, and `/file/*` with deterministic Unicode folders, long names, public/private capabilities, media files, and connected/disconnected mounts.

- [ ] **Step 5: Add workflow and screenshot scenarios**

```ts
test('@visual explorer list, grid, themes, and locales', async ({ page }) => {
  await installApiFixtures(page, { admin: true });
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Files and folders' })).toBeVisible();
  await expect(page).toHaveScreenshot('explorer-list-light-en.png', { fullPage: true });
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page).toHaveScreenshot('explorer-grid-light-en.png', { fullPage: true });
  await page.getByRole('button', { name: 'Change theme' }).click();
  await expect(page).toHaveScreenshot('explorer-grid-dark-en.png', { fullPage: true });
});
```

Add scenarios for navigation, preview, selection, context menu, mobile sheet, login error, upload panel, storage table, appearance, dialogs, loading, empty, and retry. Assert page scroll width never exceeds client width and key control bounds remain inside the viewport.

- [ ] **Step 6: Run browser verification and inspect screenshots**

Generate the first baselines with `npm run test:visual -- --update-snapshots`, inspect every generated image, then run `npm run test:e2e`. Expected: PASS in desktop, tablet, and mobile projects. Inspect nonblank rendering, graphite/orange theming, Chinese text, framing, overlap, and fixed overlays before accepting snapshots.

- [ ] **Step 7: Update bilingual documentation**

Add matching README bullets for bilingual UI, themes, keyboard selection, responsive administration, and browser-test commands. Do not change storage capabilities or the release badge before a release is published.

- [ ] **Step 8: Final validation and commit**

Run `npm run check`, `npm run test:e2e`, and `git diff --check`. Expected: all pass and `git diff --check` prints nothing.

```bash
git add package.json package-lock.json playwright.config.ts tests/e2e tests/ui/responsive-and-accessibility.test.tsx src/ui/i18n/messages.ts README.md README.zh.md
git commit -m "test: verify redesigned web interface"
```

---

## Final Review Checklist

- [ ] Map every acceptance criterion in `docs/superpowers/specs/2026-07-15-web-ui-redesign-design.md` to a completed task and test.
- [ ] Confirm no Worker, D1 migration, storage driver, OAuth, or API behavior changed.
- [ ] Confirm English and Simplified Chinese dictionaries have identical keys.
- [ ] Confirm `src/ui/styles.css` and all imports are removed.
- [ ] Confirm no visible application string bypasses localization.
- [ ] Confirm the existing 177 Worker tests and all UI tests pass.
- [ ] Confirm all Playwright projects pass.
- [ ] Inspect required viewport screenshots in both themes and both languages.
- [ ] Verify no overlap, horizontal overflow, blank preview, misplaced fixed panel, or layout shift.
- [ ] Run `npm run check`, `npm run test:e2e`, and `git diff --check` again before final review.
