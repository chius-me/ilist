# ilist Web UI Redesign Design

## Summary

Redesign the complete existing ilist frontend around OpenList's familiar file-browsing workflow while establishing an independent ilist visual identity. The redesign covers the public file browser, administrator login, file operations, previews, upload queue, storage management, and frontend appearance preferences. It does not add storage-driver features or change the existing Worker file APIs.

## Goals

- Make browsing and managing files feel coherent, efficient, and familiar to OpenList users.
- Replace the current provisional styling with a consistent, production-quality design system.
- Preserve every existing file, upload, preview, session, and mount-management capability.
- Support Simplified Chinese and English throughout the frontend.
- Provide complete light and dark themes and responsive behavior from phone to wide desktop.
- Improve loading, empty, error, success, selection, focus, and disabled states.

## Non-Goals

- Resumable OneDrive uploads or multipart S3 uploads.
- New storage drivers or changes to OneDrive, S3, R2, D1, OAuth, or authentication behavior.
- New server-side settings, user accounts, roles, sharing models, or API endpoints.
- Cross-mount copy, offline tasks, archive operations, or media transcoding.
- A pixel-for-pixel OpenList clone or reuse of OpenList branding and assets.

## Selected Direction

### Product Structure

Use an OpenList-inspired hybrid structure rather than a sidebar-heavy dashboard for the main browser:

1. Global header for the ilist identity, search entry point, theme, language, and account actions.
2. Breadcrumb bar for path navigation and path-level utilities.
3. Context toolbar that switches between ordinary directory actions and selection actions.
4. List or grid content area with responsive density.
5. Floating upload task panel.
6. Preview overlay on desktop and full-screen preview on mobile.

The browser remains the first screen. It is a file tool, not a landing page.

### Visual Language

- Base palette: neutral graphite and off-white surfaces.
- Primary action accent: restrained Cloudflare orange.
- Supporting colors: limited semantic colors for file types, success, warning, and danger.
- No gradients, decorative orbs, oversized marketing typography, or card-heavy page composition.
- Borders and shadows communicate structure only where elevation or containment is meaningful.
- Cards are limited to repeated grid files, dialogs, and genuinely framed utilities.
- Light and dark modes use the same hierarchy and semantic tokens.
- The UI keeps the existing Lucide icon dependency and normalizes icon size and stroke treatment.

### Density

- Desktop list rows target approximately 36px.
- Mobile list rows provide at least 48px touch targets.
- Grid tiles use stable responsive tracks and fixed media aspect ratios.
- Toolbars and metadata collapse progressively rather than wrapping into overlapping rows.
- Long names truncate visually while remaining available through accessible labels and properties.

## Information Architecture

### File Browser

The public and administrator browser share the same page structure. Administrator capabilities appear only when the session and current directory capabilities permit them.

The browser provides:

- Breadcrumb navigation.
- Local directory search.
- Name, date, and size sorting with ascending or descending order.
- List and grid views.
- Upload and folder creation when permitted.
- Entry preview, download, link copy, rename, move, visibility, properties, and deletion according to entry capabilities.
- Batch move, visibility, and deletion for mutable selected entries.
- Drag-and-drop uploads using the existing upload transport.

### Administration

Use a dedicated OpenList-style administration layout with a compact left sidebar. The sidebar contains:

- Return to files.
- Storage management.
- Appearance preferences.

Storage management changes from a card-like list into a scan-friendly table. Each row exposes provider, mount path, connection status, enabled state, and an action menu. Existing connect, reconnect, disconnect, test, enable, disable, edit, and delete behaviors remain unchanged.

Appearance preferences are frontend-only. They control language, theme, and default explorer view and persist in browser storage. No D1 table or Worker route is added.

### Authentication

Keep administrator authentication as a focused dialog or mobile sheet entered from the browser. Successful login returns to the previous file path. Failed login remains inline and preserves the entered username. Logout returns the interface to public capabilities without navigating away from the current public path.

## Interaction Model

### Opening and Selection

- A single click or tap opens a folder or previews a file.
- Selection uses a visible checkbox, desktop marquee selection, `Ctrl/Cmd` toggle selection, and `Shift` range selection.
- Entry selection never changes merely because the action menu was opened.
- Selection clears when navigating to another directory.
- When selection is non-empty, the normal toolbar becomes a selection toolbar.
- Desktop entry actions are available from both the action button and context menu.
- Mobile entry actions use a bottom action sheet.

### Keyboard Behavior

- `Enter` opens the focused entry.
- `Space` toggles selection for mutable entries.
- Arrow keys move the roving focus through the visible file collection.
- `Ctrl/Cmd+A` selects all mutable entries in the current filtered view.
- `Escape` clears selection, closes the topmost menu, sheet, dialog, or preview, in that order.
- Focus returns to the invoking control after an overlay closes.

### Responsive Behavior

- Desktop uses the complete file table and context menus.
- Tablet hides lower-priority metadata before reducing file-name space.
- Mobile presents file metadata below the name, enlarges touch targets, and uses bottom sheets.
- Administration collapses the sidebar to an icon rail or drawer on narrow screens.
- Preview occupies the viewport on mobile and reserves a stable header for close and download actions.
- No control, label, dialog, or file name may overlap adjacent content at supported viewport widths.

## Localization and Preferences

Implement a small typed in-project internationalization layer instead of adding a large localization framework. It provides:

- `zh-CN` and `en` dictionaries with identical keys.
- Browser-language detection for the initial language.
- Manual language switching persisted to `localStorage`.
- Locale-aware file-size, date, number, and selection-count formatting.
- A development-time or test-time parity check so missing dictionary keys fail validation.

Frontend preferences use one versioned object in `localStorage`. Invalid or unavailable storage falls back safely to:

- Browser language.
- System color scheme.
- List view.

Changing a preference updates the current screen immediately.

## Component Architecture

Retain React, Vite, the current API modules, and the existing feature components. Split orchestration so each unit has one primary responsibility:

- `AppShell`: global header, language, theme, account actions, and page outlet.
- `ExplorerPage`: directory, search, sort, view, selection, dialogs, and preview orchestration.
- `AdminLayout`: administration navigation and responsive sidebar.
- `StoragePage`: existing mount-management behavior in table form.
- `PreferencesPage`: frontend-only appearance settings.
- `PreferencesProvider`: preference loading, persistence, and document theme/language attributes.
- `I18nProvider`: typed message lookup and locale formatters.
- `ToastRegion`: non-blocking operation results with accessible live announcements.

Existing domain hooks and API modules remain authoritative for remote data. Do not introduce a global server-state library for this redesign.

## Visual System

Define semantic CSS custom properties for:

- Page, surface, raised surface, hover, selected, and scrim colors.
- Primary, danger, warning, success, text, muted text, and border colors.
- Typography sizes and weights for application chrome, compact headings, file names, and metadata.
- Spacing, radii, shadows, stable control sizes, and z-index layers.
- Focus ring, reduced-motion behavior, and skeleton colors.

Keep letter spacing at zero. Use tabular numerals for sizes, dates, progress, and counts. Avoid viewport-width font scaling. Use stable grid tracks, minimum widths, and aspect ratios to prevent layout movement.

## State and Feedback Design

### Loading

- Initial directory loading uses file-row or grid-tile skeletons matching the selected view.
- Refresh preserves existing content and displays a small non-blocking refresh indicator.
- Storage management uses table-row skeletons.
- Buttons that start mutations show a stable busy state without changing dimensions.

### Empty and Error States

Provide distinct states for:

- Empty directory.
- Search with no results.
- Private or unavailable content.
- Disconnected storage.
- Directory load failure with retry.
- Storage-management load failure with retry.
- Preview load failure with download fallback when available.

Errors use direct language and preserve recoverable user context. Do not use `window.alert`.

### Mutations

- Successful operations produce a short status notification.
- Partial batch failures keep failed entries selected and report successful and failed counts.
- Destructive actions require confirmation and name the affected entry count.
- Delete-mount and disconnect-OneDrive copy must explicitly state that provider files are unchanged.
- Upload progress, cancellation, retry, completion, and failure remain visible in the upload panel.

## Accessibility

- Preserve the skip link and semantic landmarks.
- Every icon-only control has an accessible name and visible tooltip.
- Focus indicators meet contrast requirements in both themes.
- Dialogs, menus, sheets, previews, and notifications use appropriate roles and focus management.
- Keyboard behavior matches the interaction model.
- Color is never the only signal for selection, status, or failure.
- Motion respects `prefers-reduced-motion`.
- Text and controls meet WCAG AA contrast targets.

## Testing and Verification

### Unit and Component Tests

- Preference initialization, migration, persistence, and storage failure fallback.
- English and Chinese dictionary-key parity and formatting.
- Theme and language switching.
- Single-click open and preview behavior.
- Checkbox, modifier, range, select-all, and keyboard selection behavior.
- Context menu and mobile action-sheet behavior.
- Toolbar transition between directory and selection actions.
- Loading, empty, retry, partial failure, and success states.
- Login, upload, preview, file-operation, and mount-management regressions.
- Administration navigation and responsive sidebar behavior.

### Visual and Browser Verification

Use Playwright against a local Worker dev server with deterministic test fixtures. Capture and inspect:

- Desktop list and grid views at 1440x900.
- Tablet at 834x1112.
- Mobile at 390x844.
- Light and dark themes.
- English and Simplified Chinese.
- Explorer, login, storage management, preferences, preview, upload panel, menus, dialogs, loading, empty, and error states.

Verify that no text overlaps, no controls escape their containers, fixed overlays are correctly framed, and interaction does not cause unintended layout shifts. Finish with `npm run check`.

## Delivery Sequence

1. Introduce preferences, localization, and semantic design tokens without changing behavior.
2. Build the shared shell and refactor the explorer orchestration into focused page components.
3. Redesign list, grid, navigation, toolbar, selection, and responsive interactions.
4. Redesign overlays, upload feedback, preview, and operation states.
5. Build the administration layout, storage table, and appearance preferences page.
6. Complete accessibility, localization, regression, and visual verification.

Each sequence step must leave the existing test suite passing and produce a separately reviewable commit.

## Acceptance Criteria

- All existing frontend capabilities remain functional against the unchanged Worker APIs.
- The browser follows the approved OpenList-inspired hybrid structure and single-click opening model.
- Desktop and mobile use the approved adaptive density.
- The graphite-and-orange design is complete in light and dark modes.
- Every visible application string is available in Simplified Chinese and English.
- The dedicated administration layout provides storage management and frontend appearance preferences.
- Existing API, Worker, and storage-driver behavior is unchanged.
- Automated component and Worker tests pass.
- Playwright screenshots at the required viewports show no overlap, clipping, blank content, or incoherent layout shifts.
- `npm run check` passes.
