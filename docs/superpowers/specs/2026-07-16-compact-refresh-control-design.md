# Compact Explorer Command Bar Design

## Goal

Combine the breadcrumb and explorer controls into one compact command bar so navigation and secondary actions do not consume separate rows.

## Interaction

- Keep the path index on the left and all command controls on the right.
- Render the root breadcrumb as a home icon without the `ilist` text. Continue to show child path segments, such as `/ OneDrive`.
- Order the right-side controls as search, sort field, sort direction, refresh, and view mode. Desktop administrator upload and create-folder actions remain after the view control.
- Render search as an icon by default. Activating it opens an input that expands left over the path area without moving the right-side controls.
- Focus the input when search opens. Escape, an outside click, or clearing and closing returns focus to the search button.
- Use short sort labels and size the sort-field control to its content.
- Keep the existing refresh label, tooltip, and disabled behavior. While a refresh is running, rotate the icon inside the fixed-size button without changing toolbar dimensions.
- Keep retry actions in error states unchanged.

## Responsive Layout

- Desktop and tablet use a single 54px command bar with compact controls.
- Mobile uses the same single row and keeps every icon control at least 48px square.
- Mobile renders view mode as one toggle button whose icon and accessible label describe the mode it will switch to.
- Mobile combines administrator upload and create-folder commands into a `+` menu after the view toggle. Both commands remain directly available on desktop and tablet.
- The path truncates when space is constrained. An expanded search covers the available left-side path area while the right-side action positions remain stable.
- Remove the standalone breadcrumb row and directory-command row, including their reserved vertical space, at every viewport.

## Components

- `ExplorerToolbar` owns the combined path and command layout, receives breadcrumb data, `refreshing`, and `onRefresh`, and manages the transient search-expanded and mobile administrator-menu states.
- `Breadcrumbs` renders the home-only root affordance and child path segments inside the toolbar's left region.
- `ExplorerPage` passes breadcrumbs, the directory loading state, and the refresh callback into the toolbar.
- Explorer CSS owns the stable command layout, left-expanding search overlay, compact sort field, rotating refresh icon, and removal of obsolete standalone rows.

## Verification

- UI tests verify control order, home-only root rendering, search expansion/focus/close behavior, refresh callback and disabled state, responsive view toggling, the mobile administrator menu, and accessible labels.
- Style contracts verify the single-row layout, compact sort field, stable left-expanding search, mobile touch targets, and absence of standalone rows.
- Playwright visual and end-to-end tests cover desktop, tablet, and mobile layouts.
- Run the full project check before deployment.

## Scope

This change reorganizes existing navigation, search, sorting, refresh, view, upload, and create-folder controls. It does not alter directory fetching, filtering semantics, stale-content behavior, error retries, sorting behavior, or file operations.
