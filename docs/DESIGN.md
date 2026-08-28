# Design

Everything about how this thing works: types, pipeline, what to build in what
order, and the decisions that got us here. One file on purpose. This is the
product brain. `CLAUDE.md` is how we edit the repo.

## Where things stand (2026-08-28)

**Shipped (daily use, not AMO-listed).** Preview → apply → undo. Site grouping
by eTLD+1. Known-service labels (`GitHub`). Google splits by product and
Wikipedia by title token only when two piles each meet `minGroupSize`.
D-029 popup + options UI: groups first, compact duplicates line, one primary
button, “Make tab groups” (off = reorder only), gear → options tab. Collapse,
thresholds, and duplicate detection live on the options page and feed
`buildPlan` / apply. Undo per window in `storage.session`. Popup: HTML
loading screen, React starts after `loadPopup()`. Do not pin popup height.

**Next.** Topic clustering, Archive as a group row, custom domain rules, and
AI (preview stays local; button label already follows the options toggle).
Settings for those are saved; they do not change the plan yet. Do not change
`src/core/` until a stage actually needs a new `Config` field.

**Not doing (still true).** Per-tab exclude, duplicate survivor picker, i18n,
host permission, billing, Chrome, CI, a background script that decides
anything.

## The one idea

**Functional core, imperative shell.** All decisions are made by pure functions
over plain data. All effects — reading tabs, moving tabs, storing settings — live
in a thin layer that makes no decisions.

This is not architecture astronautics. It buys three concrete things:

1. The grouping logic is testable without a browser. No mocks, no headless
   Firefox in CI. Just `buildPlan(tabs, config, now)` and an assertion.
2. The preview UI comes for free — the plan is computed before anything is
   applied, so showing the user what will happen is just rendering it.
3. Undo comes almost for free. `applyPlan` returns a snapshot of what it changed.

## Layout

    src/core/        Pure TypeScript. TabInfo[] + Config -> GroupPlan. All the logic.
    src/platform/    The only place `browser.*` is allowed. Thin adapters.
    src/ui/          React components. Render a GroupPlan, decide nothing.
    src/entrypoints/ What WXT compiles into the extension. Popup and options (D-010 still: no background script).

## Data flow

    browser.tabs.query({ windowId })
            |
            v
    [platform] toTabInfo()           drop pinned, privileged, already-grouped
            |
            v
    [core] buildPlan(tabs, config, now)   PURE — the entire product is here
            |
            v
    [ui] <PlanPreview plan={...} />  user unchecks groups and duplicate clusters
            |
            v
    [platform] applyPlan(plan, excluded, { collapse }) -> Snapshot
            |
            v
    [platform] restore(snapshot)     undo

## Types

```ts
// Firefox's tabGroups palette. Hand-written union, not imported from the
// browser — that is what keeps core free of browser types.
type GroupColor =
  | "blue" | "cyan" | "green" | "grey" | "orange"
  | "pink" | "purple" | "red" | "yellow";

type TabInfo = {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  lastAccessed: number;   // epoch ms, passed IN — core never calls Date.now()
  // No groupId: already-grouped tabs never reach the core. See D-005.
  // No pinned: pinned tabs never reach the core either.
};

type GroupProposal = {
  key: string;            // stable identity, e.g. "domain:github.com"
  label: string;
  color: GroupColor;
  tabIds: number[];
  reason: string;         // shown in the preview: "12 tabs from github.com"
};

type DuplicateCluster = {
  canonicalUrl: string;
  keep: number;           // tab id to keep — lowest tab index wins
  close: number[];        // tab ids proposed for closing
  spare: boolean;         // listed but not closed; those tabs stay in grouping
};

type GroupPlan = {
  windowId: number;
  groups: GroupProposal[];
  ungrouped: number[];
  duplicates: DuplicateCluster[];
  stats: { tabCount: number; groupCount: number; wouldClose: number };
};

type Config = {
  minGroupSize: number;      // default 3 — two tabs is not clutter
  maxGroups: number;         // default 12
  detectDuplicates: boolean; // default true
  spareDuplicateCanonicals: string[]; // default [] — clusters to list but not close
};

type Snapshot = {
  windowId: number;
  createdAt: number;
  createdGroups: { groupId: number; tabIds: number[] }[];
  closedTabs: { url: string; index: number }[];  // reopened as NEW tabs, see D-006
};

// pure, src/core/plan.ts
declare function buildPlan(tabs: TabInfo[], config: Config, now: number): GroupPlan;

// impure, src/platform/apply.ts
type ApplyResult = { snapshot: Snapshot; failedKeys: string[] };  // see D-015
declare function applyPlan(
  plan: GroupPlan,
  excludedKeys: string[],
  options: { collapse: boolean },
): Promise<ApplyResult>;
declare function restore(snapshot: Snapshot): Promise<void>;
```

`reason` on every proposal is deliberate. A grouping the user cannot explain is a
grouping the user will not trust, and the field costs nothing to carry.

`now` is unused in v1 — stale-tab detection is the first thing that needs it. It
stays in the signature because it is the seam that keeps the core pure, and
threading it in later would touch every call site.

## The pipeline

Everything is deterministic and offline. Same input, same bytes out.

**Before the core sees anything**, the adapter drops: pinned tabs, privileged
URLs, and tabs that are already in a group.

Then, in `buildPlan`:

1. **Duplicates** — same `canonicalUrl`. Clusters in `spareDuplicateCanonicals`
   are still listed (`spare: true`) but their `close` tabs stay in the input to
   everything downstream, so unchecking a cluster grows the groups. Other
   `close` tabs are removed, so the groups shown contain exactly what will exist
   after apply. Skipped entirely when `detectDuplicates` is false.
2. **Domain clustering** — bucket by eTLD+1, a bucket becomes a group at
   `minGroupSize` or more. Known services get real names (`GitHub`). Google
   splits by product and Wikipedia by title tokens, only when two piles each
   meet `minGroupSize`.
3. Whatever is left becomes `ungrouped`.

Stages share one shape, which is what makes adding stage 4 cheap:

```ts
type PlanContext = { config: Config; now: number };
type Stage = (tabs: TabInfo[], ctx: PlanContext) =>
  { groups: GroupProposal[]; remaining: TabInfo[] };
```

## Backlog (UI + product)

Locked in D-029; **popup + options chrome is shipped.** Options is the home for
almost all of it. Each grouping idea is still a new `Stage` plus a `Config`
field.

1. ~~**Options page**~~ (gear in popup header) — one scrolling page, headings,
   no tabs. Collapse-new-groups, min group size, max groups, and duplicate
   detection are wired. Grouping default / AI / archive / rules are saved
   only.
2. ~~**“Make tab groups” toggle**~~ on the popup, default on. Off = same site
   buckets, only reorder the strip (no Firefox tab-group chrome). Replaced
   Sort by domain / title.
3. ~~**Duplicates compact line**~~ — one row under groups; expand for clusters;
   close-now lives inside that block, not next to the primary button.
4. **Custom domain rules** — options list: always-name / never-group / merge
   into. Saved, not applied.
5. **Cross-site topics** — title-similarity over the remainder after domain
   clustering. Radio saved in options; sites still run.
   Wikipedia/Google *in-site* splits already ship (D-027).
6. **Archive** — stale tabs as a normal proposed group row when enabled.
   Toggle and days are saved; no Archive row yet.
7. **AI** — see below. Default **off**. Button label follows the toggle;
   nothing is sent.

Still not in the product: per-tab exclude (D-007), survivor picker, i18n
(D-003), host permission in v1 (D-002), billing.

## Where AI goes (not now, shape locked)

An optional stage that runs **instead of** title clustering, on the **same
input**: the remainder after domain clustering. Same output type. The popup
preview is **always the local deterministic plan** (instant, no network).

- Toggle in **options**, default off. Greyed out with an explanation when
  offline. Placeholder for a future API key is fine; no billing UI.
- Request fires only when the user hits the popup **primary button**
  (explicit click). Not when the popup opens.
- If the toggle is on, the primary button must say so (“Group N tabs with
  AI”). Undo is the safety net. If AI is slow or unavailable, fall back to
  the deterministic plan.
- It never sees every tab. Enabling it later is a **visible** new permission
  / network event (D-002).

## Build order

Ship after step 6. Everything else is driven by actually using it.

1. ~~**Scaffold**~~ — done. WXT + TS strict + Vitest + Biome, MV3 manifest,
   popup shows the current window's tab count, `npm run verify` green and
   confirmed to exit non-zero on a broken type.
2. ~~**`src/core/url.ts`**~~ — done. `canonicalUrl` + `registrableDomain`,
   20 tests covering the edge cases below.
3. ~~**`src/platform/tabs.ts`**~~ — done. Reads tabs into `TabInfo[]`, drops
   pinned / privileged / already-grouped.
4. ~~**`src/core/plan.ts`**~~ — done. Duplicate detection, domain clustering,
   `buildPlan`, 40 tests.
5. ~~**`src/platform/apply.ts`**~~ — done. `applyPlan` + `Snapshot` + `restore`,
   with the snapshot parked in `storage.session` (`src/platform/storage.ts`) so
   undo survives the popup closing.
6. ~~**`src/ui/`**~~ — done. Preview, per-group checkbox, duplicates toggle,
   apply, discard, undo. Not yet driven by a human against a real window — the
   README checklist is the gate before this counts as shipped.
7. ~~**CI**~~ — dropped, see D-016. `npm run verify` before each commit is the
   gate.

## Edge cases the tests must cover

### `url.ts`

```ts
/** Returns the registrable domain (eTLD+1), or null for URLs that have none. */
export function registrableDomain(url: string): string | null;

/** Returns a form of the URL suitable for equality comparison between tabs. */
export function canonicalUrl(url: string): string | null;
```

Use `tldts` for public-suffix logic. Do not hand-roll it — `user.github.io` and
`bbc.co.uk` are why the Public Suffix List exists. Both functions return `null`
rather than throwing; invalid URLs are normal input here, not exceptional.

`canonicalUrl` rules: lowercase scheme and host, drop a trailing dot on the host,
drop a leading `www.`, drop the default port, drop tracking params (`utm_*`,
`fbclid`, `gclid`, `mc_eid`, `ref_src`, `igshid` — **not** bare `ref`, see D-004),
sort remaining params by key, `null` for anything that is not http/https.

- `https://www.github.com/foo` and `https://github.com/foo` — same domain, and
  same canonical URL (leading `www.` stripped)
- `https://ben.github.io/project` — registrable domain is `ben.github.io`, **not**
  `github.io`, which is on the Public Suffix List
- `https://www.bbc.co.uk/news` -> `bbc.co.uk`
- `http://localhost:3000/` — no registrable domain, must not crash
- `http://192.168.1.10:8080/` — IP host, no registrable domain
- `https://münchen.de` — punycode and unicode host compare equal
- `about:blank`, `moz-extension://abc/page.html`, `view-source:https://x.com`,
  `file:///home/…` -> `null` from both
- `https://x.com/#/route` vs `https://x.com/#/other` — **different** pages in a
  hash-routed SPA. Drop the fragment *unless* it starts with `#/`. Record this
  reasoning in the file's doc comment, not just the behaviour.
- the empty string, and a string that is not a URL at all
- a very long URL (data URIs, OAuth redirects) — must not be pathologically slow

### Domain clustering

- Sort groups by size descending, ties by domain name ascending. Output must be
  **byte-identical** for equivalent input — test with shuffled input. A plan that
  reshuffles between runs is unusable in a preview.
- More qualifying buckets than `maxGroups`: keep the largest, rest to remainder.
- `label` is a known-service name when we have one (`github.com` → `GitHub`);
  otherwise the domain minus the public suffix, first letter capitalised.
  Ugly for `t.co`; still fine.
- `key` is `domain:<registrable domain>`, or `domain:<domain>:<product|token>`
  after a split. Colour is a deterministic hash of the key into the palette —
  same key, same colour, every time.
- empty input; every tab on one domain; every tab on a different domain
- exactly `minGroupSize` tabs on a domain — boundary, test both sides
- subdomains: `mail.google.com` and `docs.google.com` both reduce to `google.com`.
  They stay one Google group unless two products each reach `minGroupSize`, then
  they split (Gmail / Docs). One product plus crumbs stays Google.
- Wikipedia: one topic (or one topic plus crumbs) stays Wikipedia; two topics
  each at `minGroupSize` split by title token.
- 500 tabs — well under a frame; a rough timing assertion is enough

### Duplicates

- three tabs on the same canonical URL -> keep one, close two
- the kept tab is the one with the lowest index, deterministically
- a duplicate tab must not also appear in a group proposal
- a spared cluster stays in `duplicates` with `spare: true`; its close-tabs
  appear in groups and do not count toward `wouldClose`

## Known bugs

- **1×1 white-dot popup (open).** Clicking the toolbar (or unified-extensions)
  button sometimes shows a ~1px white square and never grows. First diagnosis
  (D-026): `createRoot` emptied `#root` before the first commit. Second
  (D-028): HTML is the loading screen; React mounts only after `loadPopup()`.
  **Tried and rejected:** pinning `body` to 380×240, `fit.js` bumping height,
  a 1px width mutation after React. User: do not lock popup dimensions;
  they believe it is still the loading/empty-root path. After HTML/JS changes,
  reload the add-on; a signed `.xpi` is stale until re-zipped. Firefox
  `getContentSize` can ignore `min-height` on `:root`; width belongs on
  `body`; no `viewport width=device-width` (circular with a 0-wide panel).
  If the first size is under ~30×10, Firefox may pin panel width/height and
  never resize — that is why pinning height was attempted, and why it is
  still the wrong product fix.

## Next UI (D-029, shipped chrome)

UX over polish. Popup = this window’s plan + one confirm. Options = the rest.
Native Firefox panel (Canvas, system-ui, light/dark). ~380px wide, height
follows content, max ~600. One scroller for lists; header/gear/actions stay.

**Popup first glance:** proposed groups (checkbox, colour, name, reason,
expand titles). All/None only if 2+ groups. Quiet leftovers line. Archive,
when enabled, is just another group row (not yet: no core stage). Gear
top-right → options.

**Duplicates:** one compact line (“N duplicates — will close on apply”);
expand for clusters; close-now inside that block.

**Primary:** one button (“Group N tabs” / “Reorder N tabs” / “Close N
duplicates” / “Group N tabs with AI” if the options toggle is on). Cancel.
Quiet Undo if a snapshot exists. “Make tab groups” toggle near the primary
action, default on.

**Not on the main popup:** collapse checkbox, sort buttons, equal-weight
Group/Close/Sort row, grouping-mode segmented control, thresholds.

**Options:** one page, headings in this order — Grouping (sites default /
topics), AI (off, offline-disabled), New groups (collapse), Thresholds,
Duplicates, Archive, Rules.

**States to keep:** loading (HTML spinner), working, empty, applied + undo,
error / Firefox too old.

## Decisions

Newest first. One line each; a paragraph only when the reasoning is not obvious.

- **D-029 (2026-08-28)** — Popup redesign. UX > decoration. Groups are the
  first glance; one primary apply. Duplicates are a compact expandable line.
  Drop Sort by domain/title; replace with “Make tab groups” (default on; off
  = reorder only). Settings and mode live on an options page opened from a
  header gear. AI is an options toggle, default off, request on Apply,
  preview stays local (no network in this build). Archive is a normal group
  row when the stage exists. Native Firefox chrome. Amends D-020 (duplicates
  still per-cluster in the data, quieter in the UI), D-022 (collapse moved
  to options), D-027 (sort left the popup).
- **D-028 (2026-08-27)** — The HTML file *is* the loading screen. React does
  not mount until tabs are read (`loadPopup` then `createRoot`); the first
  commit is already the preview (never `null`). `#boot` sits outside `#root`
  and hides when React paints. Popup height tracks content; **do not pin
  it.** Width stays on `body`, not `:root`. No viewport meta. Amends D-026.
- **D-027 (2026-08-27)** — Site grouping stays the default. Known services get
  real names (`GitHub`). Google splits by product (Gmail/Docs/…) and Wikipedia
  by title tokens, but only when two piles each meet `minGroupSize`. A dedicated
  control closes checked duplicates without grouping. Sort-by-domain / title
  reorders loose tabs only and is not undoable — **shipped; D-029 removes them
  from the next UI** in favour of a “Make tab groups” toggle.
- **D-026 (2026-08-26)** — First paint of the popup is a styled shell plus
  spinner, from inline CSS in `index.html`. Vite injects `style.css` via JS in
  dev, so a `<link>` alone is Times-on-white until the bundle runs. The spinner
  lives outside `#root` (`#boot`): `createRoot` clears `#root` before the first
  commit, and Firefox will size that empty frame as a 1×1 popup that never
  grows. See D-028: React now waits until there is something to paint.
- **D-025 (2026-08-26)** — One scroller for groups, leftovers, and duplicates.
  Header, “Make tab groups”, actions, and Undo stay put. Amends itself after
  D-029: the collapse checkbox left the popup.
- **D-024 (2026-08-26)** — Ungrouped tabs are an expandable list, collapsed by
  default. Titles only — still no per-tab exclude (D-007).
- **D-023 (2026-08-26)** — Partial apply names the groups that failed, not just
  how many. No retry loop; the snapshot still describes what actually happened.
- **D-022 (2026-08-26)** — Newly created groups are collapsed. A popup checkbox,
  default on, is remembered in `storage.local`. The flag is an apply option, not
  core `Config` — collapse is not a planning decision. Existing user groups are
  never touched.
- **D-021 (2026-08-26)** — Undo snapshots are keyed by `windowId` in
  `storage.session`. Last apply per window; applying in B does not erase A's undo.
- **D-020 (2026-08-26)** — Duplicate clusters are preview rows like groups:
  checkbox, kept-tab title, expand to Keep/Close. Unchecking a cluster recomputes
  via `spareDuplicateCanonicals` (same reason as D-014). The master "close
  duplicates" checkbox is gone; All/None on the section replaces it. Lowest index
  still wins — no survivor picker. Amends D-007: uncheck groups *and* clusters.
- **D-019 (2026-07-25)** — Add-on id is `tab-organizer@benk113.github.io`, fixed
  before the first signed build. AMO signs against the id, and changing it later
  makes Firefox treat the result as a different add-on that has to be installed
  again from scratch. Distribution is unlisted ("On your own"): signed, not
  published, no review queue for something one person uses.
- **D-018 (2026-07-25)** — One `icon.svg` instead of a set of PNGs. Firefox
  renders SVG extension icons and Chrome does not, which is a trade a
  Firefox-only extension can take (D-001). It also means the icon is a file you
  can edit rather than five exports you have to regenerate.
- **D-017 (2026-07-25)** — The preview lets a group be expanded to list its tabs
  by title. "12 tabs from github.com" is a claim, and the point of a preview is
  that it can be checked before agreeing rather than after. Costs nothing: the
  popup already holds every tab it read.
- **D-016 (2026-07-25)** — No CI. It was built and removed the same day: on a
  one-person project a pipeline only re-runs `npm run verify`, which already has
  to be green before every commit, and reports it to nobody. It would be
  maintenance with no reader. If this ever takes contributors, it comes back —
  the workflow file is in the history at `2414d74`.
- **D-015 (2026-07-25)** — `applyPlan` degrades instead of aborting: a proposal
  the browser refuses lands in `failedKeys` and the remaining groups are still
  created. The snapshot then describes what actually happened rather than what
  was asked for, which is the only version undo can be built on.
- **D-014 (2026-07-25)** — The duplicates checkbox recomputes the plan with
  `detectDuplicates: false` rather than filtering the existing one. Keeping the
  duplicates puts those tabs back into the domain groups, so a preview that only
  crossed out the duplicates line would be showing group sizes that are wrong.
- **D-013 (2026-07-25)** — Undo dissolves the groups it created and reopens the
  tabs it closed. It does **not** restore tab order. Grouping moves tabs
  together, so putting the strip back would mean recording every tab's old index
  and replaying a second, larger set of moves that can itself fail halfway. The
  popup says what undo does before you apply; that is enough for v1.
- **D-012 (2026-07-25)** — Added the `"tabGroups"` permission. `tabs.group()`
  needs no permission, but `tabGroups.update()` — the call that gives a group its
  title and colour — does. It is not a host permission and Firefox does not show
  it in the install prompt, so the "no host permissions, ever" line holds.
- **D-011 (2026-07-24)** — `manifestVersion: 3` is set explicitly in
  `wxt.config.ts`; WXT still defaults Firefox to MV2 and silently built one.
  `gecko.data_collection_permissions.required: ["none"]` is set too — AMO has
  required it for new extensions since 2025-11-03.
- **D-010 (2026-07-24)** — No background script in v1. The popup does everything,
  and the undo snapshot survives in `storage.session` without a process holding
  it. An empty event page that exists only because extensions usually have one is
  the kind of thing we just deleted from the docs.
- **D-009 (2026-07-24)** — No `webextension-polyfill`. WXT 0.20 gives us
  `import { browser } from "wxt/browser"`, which is `globalThis.browser ??
  globalThis.chrome`. Firefox's `browser` is natively promise-based, so on a
  Firefox-only extension the polyfill is a dependency that buys nothing — and the
  Chrome fallback we would eventually want is already in WXT's export. WXT
  auto-imports are also off, so imports stay greppable.
- **D-008 (2026-07-24)** — No `capabilities.ts`. With `strict_min_version: 139`
  the only build lacking `tabGroups` is a fork. One check in the popup, showing
  "this build doesn't support tab groups", is enough. An abstraction that answers
  one question is not an abstraction.
- **D-007 (2026-07-24)** — v1 preview allows unchecking a group, nothing else.
  No renaming, no persisted overrides. That kills the question of where user
  edits live. Renaming comes back when I miss it in practice.
- **D-006 (2026-07-24)** — `applyPlan` may close duplicate tabs; the snapshot
  stores their URLs and undo reopens them as **new** tabs. History and scroll
  position are lost, and the UI says so before you apply. The alternative —
  never closing anything — throws away half the value.
- **D-005 (2026-07-24)** — Tabs already in a group are filtered out in the
  adapter and never reach the core. If you grouped it, that was deliberate;
  don't second-guess it. Falls out of this for free: applying twice is a no-op,
  and `TabInfo` needs no `groupId`.
- **D-004 (2026-07-24)** — Strip `utm_*`, `fbclid`, `gclid`, `mc_eid`,
  `ref_src`, `igshid` — but **not** bare `ref`. It is load-bearing on GitHub,
  npm and most doc sites; stripping it merges genuinely different pages.
- **D-003 (2026-07-24)** — Everything user-facing is English, including group
  labels and `reason` strings. No i18n in v1.
- **D-002 (2026-07-24)** — Deterministic heuristics in v1, AI only in v2 and
  opt-in. An LLM is slow on a UI action expected to be instant, non-deterministic
  in a way that destroys trust in a preview, and sends browsing data somewhere.
  Most of the actual mess is one domain repeated many times, which needs no
  language model. Building the deterministic version first also gives the AI
  stage something to be measured against. Consequence: no network permission in
  the v1 manifest at all, so adding one later is a visible event.
- **D-001 (2026-07-24)** — Firefox only, `strict_min_version: "139.0"`, but all
  browser access confined to `src/platform/` so a Chrome port stays a change to
  one directory. Chrome uses a service-worker background and a different
  `tabGroups` history; designing for both now would compromise for a v1 nobody
  but me runs.
