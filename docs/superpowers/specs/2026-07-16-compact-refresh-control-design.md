# Compact Refresh Control Design

## Goal

Remove the standalone refresh row from the public file explorer so this secondary action does not consume unnecessary vertical space.

## Interaction

- Place refresh immediately after the sort-direction button and before the list/grid segmented control.
- Keep the existing label, tooltip, and disabled behavior.
- While a refresh is running, rotate the refresh icon inside the fixed-size button without changing toolbar dimensions.
- Keep retry actions in error states unchanged.

## Responsive Layout

- Desktop and tablet use the existing compact toolbar control size.
- Mobile keeps a minimum 48px refresh touch target while the toolbar action group may wrap as a unit when space is constrained.
- Remove the standalone directory-command row and its reserved vertical space at every viewport.

## Components

- `ExplorerToolbar` receives `refreshing` and `onRefresh` inputs and renders the control alongside sorting.
- `ExplorerPage` passes the directory loading state and refresh callback into the toolbar.
- Explorer CSS owns the rotating icon state and removes obsolete standalone command-row styling.

## Verification

- UI tests verify refresh placement, callback behavior, disabled state, and accessible label.
- Style contracts verify the mobile touch target and absence of the standalone row.
- Playwright visual and end-to-end tests cover desktop, tablet, and mobile layouts.
- Run the full project check before deployment.

## Scope

This change only relocates the normal refresh action. It does not alter directory fetching, stale-content behavior, error retries, sorting, or file operations.
