# Design

The visual contract for every Hub surface. Read it before touching a `.tsx` file, `src/styles.css` or anything under `src/components`. `src/typography-policy.test.ts` enforces the parts a regular expression or a token table can see; the rest is on review.

## Decisions and open questions

Decided by the owner on 2026-11-23:

1. Direction "Grid": the Swiss International Typographic Style held to a working product. It replaces the Linear-style contract. The one-weight, Inter and grey-ladder rules are retired. No tracking in screens, no uppercase, the shared roster and the enforcement test stay.
2. Light and dark are equal. The theme choice is System (default), Light or Dark.
3. Main navigation is Home, Activity, Sessions, Triggers. A Setup group holds Daemons, Connections, Profiles. Settings comes last, with an Instance section that only instance operators see. Activity lists runs; sessions keep their own list.
4. Archivo and JetBrains Mono are self-hosted variable fonts (`@fontsource-variable/archivo`, `@fontsource-variable/jetbrains-mono`, OFL-1.1).

Migration: tokens, faces, weights and corners apply everywhere now. A component in the roster marked with a later step keeps its current layout until that step rebuilds it. New screens use the target components as they land. The triggers editor and the auth entry screens keep their larger corner classes until steps 5 and 10; the radius tokens draw them at 2 px and the policy test lists them.

Open:

1. The dark state inks are prototype values. They stay while the contrast table in `src/typography-policy.test.ts` passes with them.

## Overview

Hub is a working tool for a small team that wants to know, in a glance, what its agents are doing now. The look is the Swiss International Typographic Style held to four contributions: type, palette, density and one signature move. Navigation, controls and layout are the standard ones for a web app.

Objective type on a strict grid, set flush left. Colour carries meaning and nothing else. Counts that matter are set big. Rules (lines), not boxes, separate content.

The signature move has two parts:

1. **Figures.** The number a section is about is set as an oversized flush-left numeral over a heavy rule: "3 running", "1 needs you", "14 runs today", "6m 31s". `Figure` owns it.
2. **State blocks.** Every record row starts with a solid colour block carrying a text label: red for needs a person, ultramarine for live, ink for done, grey for off. A failed run nobody has opened keeps its block and says "Not opened yet". `StateBlock` owns it.

## Hard rules

1. **Two weights.** 400 for reading, 600 for the strong voice. Only components in `src/components` and the shell in `src/shell` set 600, through `font-strong`. A screen never sets a weight. `font-title`, `font-medium`, `font-semibold`, `font-bold`, `<strong>`, `<b>` and `fontWeight` do not exist here.
2. **Colour is information.** Each state ink has one meaning everywhere (see Colours). Never use a state ink for decoration, emphasis or brand.
3. **Every text token passes AA in both themes.** There is no below-AA text step. Placeholders use `muted-foreground`.
4. **No tracking in screens, no uppercase.** Tracking exists only as a token on the title and figure sizes. Labels are sentence case.
5. **The scale is the scale.** No arbitrary sizes, colours or spacing. Tokens live in `src/styles.css` only.
6. **Shared first.** Screens compose `src/components/app`. A missing shape is added there, never hand-rolled in a panel. Fix the component, not the leaf.
7. **One theme mechanism.** Only the theme module (`src/theme/`) and `src/routes/__root.tsx` set the theme class. Components read tokens; `dark:` variants do not exist.

## Colours

Tokens live in `src/styles.css`: light values in `:root`, dark values in `.dark`. Every token that is not an alias exists in both blocks.

Surfaces and text:

| Token                         | Light                 | Dark                  | Role                                                                                                 |
| ----------------------------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `background`                  | `#f7f7f4` paper       | `#111111`             | The page.                                                                                            |
| `card`                        | `#efefeb`             | `#1a1a1a`             | Raised fills: code, inset panels, the forms that still sit in a card. Not a box around page content. |
| `popover`                     | `#f7f7f4`             | `#1a1a1a`             | Menus, dialogs, the command menu, sheets.                                                            |
| `accent`                      | `#e6e6e1`             | `#242424`             | Hover and selected fill on the page.                                                                 |
| `foreground`                  | `#111111` ink         | `#ededea`             | Primary text, heavy rules, done blocks.                                                              |
| `muted-foreground`            | `#5a5a55`             | `#a5a5a0`             | Secondary text, captions, placeholders. AA on `background`, `card` and `accent`.                     |
| `border`                      | `#d9d9d4`             | `#2f2f2c`             | Row rules.                                                                                           |
| `input`                       | `#8a8a85`             | `#6f6f6a`             | Control borders, the table header rule. 3:1 against the page.                                        |
| `primary` / `-foreground`     | `#111111` / `#f7f7f4` | `#ededea` / `#111111` | The primary button: an ink fill.                                                                     |
| `destructive` / `-foreground` | `#b71d14` / `#ffffff` | `#ff7b70` / `#111111` | Destructive button fill and error text.                                                              |
| `link`                        | `foreground`          | `foreground`          | Links are ink and underlined; colour is not spent on them.                                           |
| `ring`                        | `#111111`             | `#ededea`             | Focus: 2 px outline, 2 px offset.                                                                    |

State inks, used by `StateBlock`, `Figure` tone, `StatusLine` tone and badge counts only:

| Token       | Light block / text    | Dark block / text     | Meaning                                                                                                       |
| ----------- | --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `attention` | `#d9261c` / `#b71d14` | `#ff6b5f` / `#ff7b70` | Needs a person: failed, timed out, rejected, needs authorization, needs permission, an offline daemon in use. |
| `live`      | `#2340d6` / `#2340d6` | `#8ca0ff` / `#93a6ff` | Running, working, starting, the current item, what you follow.                                                |
| `done`      | ink / ink             | `#ededea` / `#ededea` | Succeeded, connected, online, on.                                                                             |
| `off`       | `#d9d9d4` / `#5a5a55` | `#2f2f2c` / `#a5a5a0` | Queued, paused, off, closed, canceled, not set up.                                                            |

Each state has a `-foreground` for the label on its block and a `-text` for the state set as type. There is no amber. Something either needs a person or it does not. Until rows move to `StateBlock`, `StatusPill` and `Checklist` read the old tone names, which now alias the state inks: `success` is done, `warning` and `danger` are attention, `neutral` is off.

Shell, in both themes: `rail` `#111111` (`#0a0a0a` dark), `rail-foreground` `#f7f7f4`, `rail-muted` `#a8a8a3`, `rail-accent` for hover, `rail-border` `#2e2e2e`. The current navigation item is a `live` fill with `live-foreground`. The rail is the one committed colour field; it stays ink in light mode. The `sidebar-*` tokens alias the rail.

Charts use `foreground` for bars and `attention` only for a bar that carries a failure. There is no chart palette.

## Typography

Faces, self-hosted, loaded once in `src/styles.entry.js`:

1. Archivo Variable for everything. Width stays at 100.
2. JetBrains Mono Variable (`font-mono`) for identifiers, run numbers, daemon names, commands, times in a timeline, URLs and keys.

Weights: `font-normal` 400 and `font-strong` 600. The `@theme` weight namespace is cleared, so no other weight utility exists.

`font-strong` belongs to components: page and dialog titles, section headings, record titles, table headers, buttons, the current navigation item, figures and state block labels.

Scale (Tailwind names remapped in `@theme`; use the name for the role):

| Utility     | Size / line | Role                                                                                       |
| ----------- | ----------- | ------------------------------------------------------------------------------------------ |
| `text-xs`   | 12 / 16     | Captions, state block labels, table headers, timestamps, badges.                           |
| `text-sm`   | 14 / 20     | The UI size: cells, controls, navigation, facts, section headings.                         |
| `text-base` | 15 / 24     | Body and prose: descriptions, prompts, agent output. The `<body>` default.                 |
| `text-lg`   | 20 / 24     | A secondary figure inside a row, such as a 7-day count.                                    |
| `text-xl`   | 32 / 36     | The page title. 28 / 32 under 860 px. Tracking -0.015em as a token.                        |
| `text-2xl`  | 40 / 40     | `Figure` medium: durations and totals in rows. Tracking -0.025em.                          |
| `text-3xl`  | 56 / 56     | `Figure` large: the one number a section is about. 48 / 48 under 860 px. Tracking -0.03em. |

`tabular-nums` on every figure, table and timeline; `DataTable` sets it for the whole table. `text-wrap: balance` on titles and `text-wrap: pretty` on descriptions.

## Layout

1. **Grid.** 12 columns from 860 px with a 24 px gutter; one column with a 16 px gutter below. Rows align to the grid: state block in columns 1 and 2, the record in 3 to 7, where it runs in 8 and 9, time or actions in 10 to 12.
2. **Measure.** Prose is at most 72 characters wide.
3. **Spacing.** Steps of 4, 8, 12, 16, 24, 32, 40, 56 and 72 px. Sections are 56 px apart (40 px on phones). A section starts with a 2 px `foreground` rule and its heading 12 px below.
4. **Density.** Controls are 36 px high on desktop and 44 px on phones. Table rows have 16 px vertical padding. State blocks are 28 px high.
5. **Page column.** Up to 1240 px wide, 40 px inset on desktop, 16 px on phones. The shell owns it; screens never pad themselves.
6. **Shell, desktop.** A 232 px ink rail: organization switcher, search (opens the command menu and shows the shortcut), the main group, the Setup group, Settings, then Attention, Help and the account menu with the theme choice at the foot. The content header holds the breadcrumb and route actions.
7. **Shell, phone (under 860 px).** An ink top bar (mark, section name, search) and a fixed ink bottom bar: Home, Activity, Sessions, Attention, More. Content pads clear of it. A detail page's primary action sits in a sticky bar above it. Route actions move under the page title.
8. **Detail pages.** Content in columns 1 to 8, facts in 9 to 12. On phones, facts follow the content.
9. **State blocks on phones** are a label above the record, not a full-width bar. They keep their desktop width: fit to the label, at least 96 px.

## Elevation and depth

Flat. Hierarchy comes from rules, size and weight, never from shadow or blur.

1. Heavy rule (2 px `foreground`): the top of a section, a status line, a chart baseline.
2. Strong rule (1 px `input`): the table header, control borders.
3. Hairline (1 px `border`): between rows.
4. Floating layers (menus, dialogs, the command menu, toasts) have a 1 px `input` border and `shadow-floating`, the only shadow in the system.

Motion is colour and background only, 150 ms, and `src/styles.css` switches all of it off under `prefers-reduced-motion`. No component carries its own reduced-motion variant.

## Shapes

1. Corners are 0 on state blocks, badges, charts and figures, and 2 px (`rounded-sm`) on controls, menus, dialogs and the theme switch. Nothing is rounder.
2. No cards around page content. Groups are separated by rules and space. A bordered box is for a floating layer, a form control, or a component the roster below still lists as a card.
3. Marks are squares: state blocks, timeline points (8 px), the organization initial.

## Components

Everything a screen composes lives in `src/components/app`. The shadcn primitives in `src/components/ui` are the raw material; a screen imports from `ui` only for `Button`, `Input`, `Textarea`, `Select`, `Checkbox`, `Label` and the menu or dialog primitives it composes inside an app component.

The "Step" column says when a component reaches its Grid form: "Now" means it already has it, a number is the redesign step that builds or rebuilds it.

| Component                                                               | The one way to                                                                                                                       | Step |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `Page`, `PageHeader`, `PageHeaderSkeleton`                              | Lay out a screen: the column, the one `h1`, its description, status and actions.                                                     | 1    |
| `SiteHeader`, `SiteHeaderActions`, `SidebarSwitcher`, `NavigationGroup` | The shell, in `src/shell`: rail, phone bars, breadcrumb. Header actions render from `sm` up only.                                    | 1    |
| `CommandMenu`                                                           | Cmd+K: navigate, act, switch organization, toggle theme.                                                                             | 1    |
| `ThemeSwitch`                                                           | System, Light, Dark. Reads and writes the theme module only.                                                                         | 1    |
| `ErrorPage`, `NotFoundPage`, `RefusedPage`                              | Errors, 404 and refusals inside the shell: cause, then Retry or Go home.                                                             | 2    |
| `PageAlert`                                                             | Page attention: one stack at the top of a page, one item per source, each with one action. Replaces `WarningAlert` as a page banner. | 3    |
| `AttentionMenu`                                                         | The shell's Attention entry and its list of organization-wide items.                                                                 | 3    |
| `Toaster`, `toast()`                                                    | Confirm a completed action, with View or Undo where possible.                                                                        | 3    |
| `AppStatusBar`                                                          | App-level trouble (connection lost, session expired) inside the shell, with Retry.                                                   | 3    |
| `FailureAlert`, `NoticeAlert`                                           | A failed request, or a neutral or success notice, as a polite live region.                                                           | 3    |
| `WarningAlert`                                                          | Warn without blocking, inside a form or section.                                                                                     | 3    |
| `StatusLine`                                                            | A polite live region with reserved height.                                                                                           | 3    |
| `StateBlock`                                                            | Start a record row with its state: colour block plus label. Replaces `StatusPill` in rows. `unseen` adds "Not opened yet".           | 4    |
| `StateLabel` (module)                                                   | Name each object's states once: connection, daemon, run, session, trigger. Every pill, block, banner and sentence reads from it.     | 4    |
| `StatusPill`                                                            | Show state outside a row. Never `Badge`, never a coloured span.                                                                      | 4    |
| `RecordRow`, `RecordList`                                               | A grid row: state block, title and one line, where, time or actions. The whole row links when it navigates.                          | 4    |
| `DataTable`, `DataRow`, `DataCell`, `DataTableSkeleton`                 | Tabular records. Restacks into labelled rows under 860 px. Empty means `EmptyState` alone.                                           | 4    |
| `Section`                                                               | A 2 px rule, a heading, an optional figure and an optional trailing action.                                                          | 4    |
| `Figure`                                                                | The number a section is about: big numeral, unit, optional caption, optional tone (`attention`, `live`).                             | 4    |
| `TwoLine`                                                               | A primary fact over a muted secondary one, in a cell or a row.                                                                       | 4    |
| `SummaryPanel`                                                          | Labelled facts as a description list.                                                                                                | 4    |
| `Steps`                                                                 | Number a run of steps in order and join them with a rail.                                                                            | 5    |
| `StickyActions`                                                         | A detail page's primary action on phones, above the bottom bar.                                                                      | 5    |
| `Checklist`, `ChecklistItem`, `ChecklistProgress`                       | Steps toward a goal: a state mark, what to do, and one action per step.                                                              | 6    |
| `StatTile`, `StatGrid`, `StatTileSkeleton`                              | Retired at step 6; use `Figure` inside `Section`. Until then, four or five tiles sit two across on a phone.                          | 6    |
| `DeviceCard`, `DeviceCardSkeleton`                                      | A machine: name, identifier, one state, last seen, and its facts.                                                                    | 8    |
| `Card`, `CardSkeleton`                                                  | A bordered surface for settings and auth forms only. Icon, title, status, description and action optional.                           | 9    |
| `EmptyState`                                                            | Say there is nothing here and what to do about it.                                                                                   | Now  |
| `FormField`, `FieldSkeleton`                                            | Label a control, with optional description and error. Wraps any control.                                                             | Now  |
| `CheckboxField`                                                         | Label a checkbox beside its box, with what ticking it means underneath.                                                              | Now  |
| `FormActions`                                                           | The button row under a form: stacks on phones, right-aligns from `sm`.                                                               | Now  |
| `FormDialog`                                                            | A dialog whose body is one form with one submit.                                                                                     | Now  |
| `ConfirmAction`, `ConfirmMenuItem`                                      | Ask before something irreversible.                                                                                                   | Now  |
| `Spinner`, `LoadingLine`, `PanelSkeleton`                               | Wait. Skeletons for pages, a spinner for one fact.                                                                                   | Now  |
| `SegmentedControl`                                                      | Pick one of a few modes, with radio semantics.                                                                                       | Now  |
| `TabNav`, `TabNavSkeleton`                                              | Navigate between sibling routes under one page.                                                                                      | Now  |
| `Combobox`                                                              | Pick one of many with search.                                                                                                        | Now  |
| `CopyField`, `CopyButton`, `CopyBlock`, `CodeBlock`                     | Show a value to copy, or a block of code.                                                                                            | Now  |
| `Disclosure`                                                            | Open and close a section.                                                                                                            | Now  |
| `RowActions`                                                            | Put a record's actions behind one kebab.                                                                                             | Now  |
| `RelativeTime`                                                          | Show when. There is no absolute-date formatter in screens.                                                                           | Now  |
| `AuthLayout`, `AuthCard`, `AuthCardSkeleton`, `AuthForm`, `AuthActions` | Frame a pre-auth screen, its form, or the buttons under a card with no form left to submit. Never `FormActions` there.               | 10   |

Rules for the roster:

1. A component owns its spacing to its neighbours. Callers never add `mb-*` or `mt-*` to a shared component; if the rhythm is wrong, fix it in the component.
2. Every alert is one anatomy, owned by `Alert`: a tone glyph, a title, the message under it, and at most one control at the far edge, centred against the whole message. A caller passes those four things and never assembles them. The control sits at the far edge from `sm` up and takes its own row under the message on a phone.
3. An alert standing in a page stack takes `standalone`, because nothing else owns the distance after it. Inside a form, a dialog or a section, leave it off.
4. A list with nothing in it is the empty state alone on the background. `DataTable` renders it instead of the table.
5. Every skeleton lives next to the component it mirrors and shares its box.
6. A value in a `CopyField` breaks anywhere; pass `prose` when the value is a sentence.
7. Every component has one visual result. `className` is for placement in a grid only; if a caller needs it to change a look, the component is missing a prop.
8. Delete what nothing imports. Dead primitives in `ui` are deleted, not kept for later.

Notification levels, one component each: field (`FormField` error), section (`StatusLine`), page (`PageAlert`), organization (`AttentionMenu`), completed action (`Toaster`), app (`AppStatusBar`), empty (`EmptyState`), loading (a skeleton or `LoadingLine`).

## Do and don't

Do:

1. Lead every page with what the person came for, and set its number as a `Figure`.
2. Start every record row with a `StateBlock` and take its label from `StateLabel`.
3. Check every screen in light and dark, at 1280 and 390 px, before calling it done.
4. Keep prose under 72 characters and let descriptions wrap with `text-wrap: pretty`.

Don't. The test checks the items marked "(test)":

1. Set a weight in a screen file, or use any weight other than `font-normal` and `font-strong`. (test)
2. Use `tracking-*`, `letter-spacing`, `uppercase` or `text-transform` outside the scale tokens in `src/styles.css`. (test)
3. Use off-scale arbitrary values (`text-[`, `font-[`, `bg-[`, `p-[` and the like) or hex colours in `.tsx`. A bracket that reads a CSS variable is allowed. (test)
4. Use `dark:` variants, or write the theme class anywhere but the theme module and `__root.tsx`. (test)
5. Define a token in `:root` without its `.dark` value, or the reverse. (test)
6. Ship a text and background pair below 4.5:1, or a control border below 3:1, in either theme. (test)
7. Reference `extra-muted-foreground`, which is removed. (test)
8. Use `rounded-md` or larger, or `shadow-*` on anything that does not float. (test)
9. Use a state ink for decoration, or show state by colour alone.
10. Wrap page content in a card, nest a card in a card, or draw a coloured side stripe.
11. Use `Badge` for state, or a raw `<pre>`, `<dl>`, `<table>` or `<details>` in a screen.
12. Put a size class on an `<h2>` or `<h3>`. Heading levels are semantic; `Section` and `PageHeader` set the size.
13. Hand-roll anything the roster has, even once.
