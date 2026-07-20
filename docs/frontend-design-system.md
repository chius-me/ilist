# ilist Frontend Design System

**Design read:** ilist is a **self-hosted product file manager**—dense, tool-first UI for browsing mounts, selecting entries, running admin operations, and managing shares—not a marketing landing page.

This document adapts methodology from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (`design-taste-frontend` dials + anti-slop, `redesign-skill` audit-first upgrade) for a **data-dense multi-step product surface**. Marketing defaults (high VARIANCE, cinematic GSAP motion, bento heroes) are **out of scope**.

## Dials (product-UI values)

| Dial | Value | Rationale for ilist |
| --- | ---: | --- |
| `DESIGN_VARIANCE` | **2** | Perfect-to-near symmetry. File managers reward predictable columns, toolbars, and dialogs—not artsy asymmetry. |
| `MOTION_INTENSITY` | **2** | Near-static. Prefer 120–160ms ease transitions on color/border/shadow only. No scroll-pinning, marquees, or perpetual loops. Honor `prefers-reduced-motion`. |
| `VISUAL_DENSITY` | **7** | Cockpit / packed data. Tight rows, compact toolbars, tabular numbers, minimal empty chrome. |

Cross-references in this repo use these exact dial names only—never invent aliases such as `LAYOUT_VARIANCE`.

## Scope limits (Taste Skill adapted, not copied)

- **Not a landing page:** no GSAP marketing motion by default, no high-VARIANCE artsy layouts, no three equal marketing cards, no hero split-screen, no Awwwards motion theater.
- **Product surfaces only:** explorer, admin (storages/shares/preferences), public share viewer, overlays (dialogs, preview, toasts, menus).
- **Stack:** keep React + CSS custom properties. Do not migrate to Tailwind/shadcn for this system.
- **Brand continuity:** warm stone neutrals + terracotta/burnt-orange accent already in production tokens—do not rebrand to emerald/violet for novelty.

## Tokens

Source of truth: `src/ui/styles/tokens.css`.

### Color

- **Neutrals:** warm stone (`--color-page`, `--color-surface`, `--color-border`, `--color-text`, `--color-muted`).
- **Single accent family:** terracotta (`--color-primary`, `--color-primary-hover`, `--color-accent-foreground*`, `--color-selected`). One hue family in light and dark.
- **Semantic:** danger / success only for destructive and positive outcomes—not decoration.
- **Icons:** folder/file tints for scanning density; never compete with primary CTAs.

### Type hierarchy

| Role | Size | Weight | Notes |
| --- | --- | --- | --- |
| App chrome title | 17px | 750 | Site name only |
| Section / dialog title | 15–16px | 700 | Overlays, admin headers |
| Body / row primary | 13–14px | 650 | Entry names, buttons |
| Meta / tabular | 11–12px | 500–600 | Sizes, dates, muted labels |
| Caption / status | 12px | 500 | Toasts meta, progress |

Font stack: system UI sans (`Aptos` / SF Pro / Segoe UI). No Inter-as-default “AI landing” stack, no decorative display fonts in product chrome.

### Shape (radius scale)

Pick **one** scale and keep it:

| Token | Value | Use |
| --- | --- | --- |
| `--radius-control` | 5px | Buttons, inputs, icon buttons, chips |
| `--radius-panel` | 7px | Panels, cards, dialogs, menus, toasts |
| `--radius-media` | 6px | Grid media corners inside cards |

**Ban:** mixing pill-full controls with sharp 0 cards, or inventing ad-hoc 8/10/12px radii for the same role. Grid cards use `--radius-panel` (or documented `--radius-media` for media only).

### Spacing scale

Use multiples of **4px** (and 2px for hairline gaps only):

`2, 4, 6, 8, 10, 12, 16, 20, 24, 32`

| Token | Value | Role |
| --- | --- | --- |
| `--space-1` | 4px | Icon gaps |
| `--space-2` | 8px | Control padding rhythm |
| `--space-3` | 12px | Panel padding |
| `--space-4` | 16px | Section gaps |
| `--space-5` | 24px | Page gutters |
| `--control-size` | 36px | Header/control target height |
| `--control-size-sm` | 34px | Dense toolbar icons |

### Layers (z-index)

| Token | Value | Role |
| --- | --- | --- |
| `--layer-header` | 10 | App header |
| `--layer-sticky` | 20 | Sticky toolbars inside panels |
| `--layer-menu` | 30 | Action menus / sheets |
| `--layer-overlay` | 40 | Dialogs, preview, login |
| `--layer-toast` | 50 | Toasts |

Do not invent free-floating z-index numbers for the same roles.

### Motion

| Token | Value |
| --- | --- |
| `--transition` | 140ms ease |

Allowed: hover/active color, border, background, focus ring, 1px press translate on buttons.  
Disallowed by default: page-level parallax, infinite pulse on static chrome, staggered list entry animations, marketing scroll reveals.

`prefers-reduced-motion: reduce` collapses transitions (see `base.css`).

### Interactive state cycles

Every control that can be activated must define:

1. **Rest**  
2. **Hover** (pointer devices)  
3. **Active / pressed**  
4. **Focus-visible** (`--focus-ring`, never remove outline without replacement)  
5. **Disabled** (opacity + `not-allowed`)  
6. **Loading** (busy labels / spinners, disable double-submit)  
7. **Empty** (explorer empty states)  
8. **Error** (inline form error + toast/error state)

Lists/grids add: **selected**, **keyboard focus row**, **drag-over** (upload).

## Surface rules

### Explorer

- One primary work surface: file list/grid fills the viewport under a compact toolbar.
- Selection toolbar replaces the normal toolbar when selection is non-empty—do not stack both.
- Dense rows; folders before files; tabular size/date.

### Overlays

- Dialogs: raised surface, `--radius-panel`, scrim, focus trap + `inert` on background (existing modal pattern).
- Preview: strong scrim; media on dark canvas; chrome matches product controls.

### Admin / shares

- Same control language as explorer (buttons, tables, forms).
- Tables prefer plain structure over card grids of equal marketing tiles.

### Public share

- Same tokens and density; fewer admin affordances; password / empty / disabled states explicit.

## Anti-slop bans (adapted)

Hard bans for ilist product UI:

- Purple/blue “AI gradient” defaults, neon glow CTAs, glassmorphism on every panel  
- Three equal feature/marketing cards as a layout pattern  
- Random mixed corner radii without a documented role  
- Cinematic/page-wide motion, infinite micro-loops on idle chrome  
- Inter + slate-900 generic SaaS landing palette as a redesign target  
- Centered hero sections, bento decoration, “quietly used by” social proof strips  
- Decorative mono-caps brand strips (`TYPE / FORM / MOTION`)  

Allowed accents remain **terracotta/burnt orange** only, with warm neutrals.

## Implementation map

| Concern | Location |
| --- | --- |
| Tokens / dials as CSS vars | `src/ui/styles/tokens.css` |
| Base controls & a11y | `src/ui/styles/base.css` |
| Shell header | `src/ui/styles/shell.css` |
| Explorer density | `src/ui/styles/explorer.css` |
| Dialogs / preview / toasts | `src/ui/styles/overlays.css` |
| Admin | `src/ui/styles/admin.css` |
| Breakpoints | `src/ui/styles/responsive.css` |
| Pure UI logic | `src/ui/lib/*` |

## Intentional CSS aliases

Short aliases (`--bg`, `--surface`, `--line`, `--text`, `--muted`, `--accent`, `--radius`) remain **documented bridges** for dense feature CSS. They must always point at the semantic `--color-*` / `--radius-*` tokens and must not introduce a second palette.

New styles should prefer semantic names (`--color-border`, `--radius-control`). Alias-only new inventing is banned.

## Logic extraction principles

- Keep I/O in hooks/API modules (`useDirectory`, `api/*`).
- Keep pure transitions in `src/ui/lib` or feature reducers (e.g. upload reducer).
- Page components orchestrate; they should not re-implement sort, selection math, or deferred toast scheduling inline when a pure helper exists.
- Unit tests import **shipped** modules—never re-implement the unit under test.

## Checklist for new UI work

- [ ] Fits design read (product file manager density)  
- [ ] Respects VARIANCE 2 / MOTION 2 / DENSITY 7  
- [ ] Uses token radius/spacing/layers—no magic z-index for shared roles  
- [ ] Full state cycle for new controls  
- [ ] No anti-slop patterns  
- [ ] Pure logic extracted + tested when non-trivial  
