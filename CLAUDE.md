# CLAUDE.md — Tab Organizer

Firefox MV3 extension that turns hundreds of open tabs into a handful of tab
groups. It always shows a preview first; nothing is regrouped without a click.

Solo hobby project. **Product brain:** @docs/DESIGN.md — shipped behaviour,
backlog, known bugs, popup + options UI. Read it before changing grouping
or the popup. **How we work:** this file.

## Stack

TypeScript (`strict`), WXT, React (popup and options page), Vitest, Biome, `tldts`.
Minimum Firefox **139** — `tabs.group()` landed in 138, `tabGroups.update()`
(title, colour, collapsed) in 139. No Chrome target.

`import { browser } from "wxt/browser"` — **not** `webextension-polyfill`, which
we do not depend on. Firefox's `browser` is already promise-based; WXT's export
is a two-line shim that falls back to `chrome` elsewhere. Auto-imports are off,
so every import is written out.

## Commands

    npm run dev        # WXT dev server, launches Firefox with the extension
    npm run build      # production build into .output/
    npm run zip        # AMO-ready archive
    npm run test       # vitest run
    npm run typecheck  # tsc --noEmit
    npm run lint       # biome check
    npm run verify     # typecheck + lint + test — green before every commit

## How we work

- **Work directly on `main`.** No tickets, no branches, no plan-approval dance.
- **Just do the thing.** For anything touching more than ~2 files, one short
  paragraph of what you're about to do, then start — don't wait for a "go".
- **Decide small things yourself** and say in one line what you decided.
  Ask only when it changes the data model, costs a dependency, or is genuinely
  a coin flip.
- **Tests only where they earn their keep:** `src/core/`, and only for logic
  with real edge cases (`url.ts`, the plan pipeline). No tests for adapters,
  no tests for React components.
- **Never add a dependency without asking.** Never add a host permission.
- **I run git.** You may `git status`, `git diff`, `git log`. Commit only when
  I say so in that message — I read the diff first.

## Code rules

- No `any`, no `!` non-null assertions. Use `unknown` and narrow.
- `src/core/` is pure: no `browser.*`, no I/O, no `Date.now()`, no
  `Math.random()`. Time is a parameter.
- `src/platform/` is the only place `browser.*` appears, and it makes no
  decisions.
- If you're writing an `if` in `src/platform/` or `src/ui/`, the decision
  probably belongs in `src/core/`.
- Exported core functions get a one-line doc comment stating what they
  *guarantee* ("groups sorted by size desc, stable for ties"), not what they do.

## Gotchas that will otherwise waste your time

- `browser.tabs.query({})` returns tabs from every window. Always pass an
  explicit `windowId`.
- Firefox MV3 uses a **non-persistent event page**, not a service worker.
  Module-level state does not survive; persist to `browser.storage.session`.
- Privileged URLs (`about:`, `moz-extension:`, `chrome:`, `view-source:`,
  `file:`) cannot be grouped or moved. Filter them in the adapter, never in core.
- Keep `browser_specific_settings.gecko.id` — AMO signing needs it.
- Firefox action popups can freeze as a **1×1 white dot**. Do not “fix” that
  by pinning popup height for the whole session (tried, rejected). Boot `body`
  at **380×120** (`height`, not `min-height` — Firefox ignores min-height in
  `getContentSize`); it becomes `height: auto` once `#root` has content.
  Loading CSS is inline in `index.html`; `style.css` is imported from
  `main.tsx`, never a blocking `<link>`. React mounts only after `loadPopup()`.
  Width on `body`, not `:root`. No `viewport width=device-width`. Popup
  light/dark is explicit panel colours plus `color-scheme` on `:root` —
  `Canvas` in the action popup often stays light (D-032). See D-031
  and **Known bugs** in DESIGN.md. Reload the add-on after HTML changes
  (`npm run dev` restart, or about:debugging → Reload). A signed `.xpi` will
  not pick up the working tree until you zip and reinstall.
