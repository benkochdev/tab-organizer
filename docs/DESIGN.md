# Design

Everything about how this thing works: types, pipeline, what to build in what
order, and the decisions that got us here. One file on purpose. This is the
product brain. `CLAUDE.md` is how we edit the repo.

## Where things stand (2026-08-29)

**Shipped (daily use, not AMO-listed).** Preview → apply → undo. Site grouping
by eTLD+1. Known-service labels (`GitHub`). Google splits by product and
Wikipedia by title token only when two piles each meet `minGroupSize`.
Custom domain rules (D-033). Loose tabs join existing groups (D-034). Topics
(D-035) cluster leftovers by title after sites, when that mode is on. Archive
(D-038) peels idle tabs into one group row when enabled.
D-029 popup + options UI. Collapse, thresholds, duplicates, rules, and grouping
mode live on the options page and feed `buildPlan` / apply. Undo per window in
`storage.session`. Popup: HTML loading screen, React starts after `loadPopup()`.
Do not pin popup height. `npm run dev` fixture includes three Lisbon leftovers
for topics, and `example.net/old` whose `lastAccessed` the adapter reports as
0 in dev only (Firefox cannot write that field).

**Next.** AI is parked (D-036). Daily use drives anything else.

**Not doing (still true).** Per-tab exclude, duplicate survivor picker, i18n,
host permission, billing / paywall, Chrome, CI, a background script that
decides anything, a “create group” control in the popup (D-037 — Firefox
already can).

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
            |                        existing groups kept as fingerprints
            v
    [core] buildPlan(tabs, config, existingGroups, now)   PURE
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
  existingGroupId?: number; // set when adding to a group that already exists
};

type ExistingGroup = {
  id: number;
  title: string;
  color: GroupColor;
  urls: string[];         // member URLs for matching; those tabs stay grouped
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
  rules: DomainRule[];       // default [] — host/site overrides, D-033
  groupingMode: "sites" | "topics"; // default "sites" — topics only on leftovers
  archiveEnabled: boolean;  // default false
  archiveDays: number;      // default 14
};

type Snapshot = {
  windowId: number;
  createdAt: number;
  createdGroups: { groupId: number; tabIds: number[] }[];
  closedTabs: { url: string; index: number }[];  // reopened as NEW tabs, see D-006
};

// pure, src/core/plan.ts
declare function buildPlan(
  windowId: number,
  tabs: TabInfo[],
  config: Config,
  existingGroups?: ExistingGroup[],
  now?: number,
): GroupPlan;

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

`now` is used by Archive (D-038). It stays in the signature so the core never
calls `Date.now()`. The popup passes it in.

## The pipeline

Everything is deterministic and offline. Same input, same bytes out.

**Before the core sees anything**, the adapter drops: pinned tabs, privileged
URLs, and tabs that are already in a group. Those existing groups are passed in
as fingerprints (id, title, colour, member URLs) so loose tabs can join them
without the core regrouping their members (D-005, D-034).

Then, in `buildPlan`:

1. **Duplicates** — same `canonicalUrl`. Clusters in `spareDuplicateCanonicals`
   are still listed (`spare: true`) but their `close` tabs stay in the input to
   everything downstream, so unchecking a cluster grows the groups. Other
   `close` tabs are removed, so the groups shown contain exactly what will exist
   after apply. Skipped entirely when `detectDuplicates` is false.
2. **Archive** — if enabled, tabs idle for `archiveDays` (compared to `now`,
   never `Date.now()`) become one Archive row. One tab is enough. never-group
   tabs are skipped. If a group titled Archive already exists, idle tabs join it
   (D-034 apply path). Counts toward `maxGroups`. `lastAccessed` 0 is “very long
   ago” once `now` is past the threshold.
3. **Join existing groups** — a loose tab joins an existing group when they share
   a host, a Google product, or a site, or when an always-name / merge-into rule
   matches the group's title. One tab is enough. never-group tabs do not join.
   Host beats product beats site. A Gmail-only group does not take Docs tabs.
   When two groups match equally, the larger one wins, then the lower id. Join
   proposals do not consume `maxGroups`. Apply adds the tabs with
   `tabs.group({ groupId })` and does not retitle, recolor, or collapse the
   existing group. Undo ungroups only the tabs that were added.
4. **Domain rules** — after joins, before site clustering. Empty pattern skipped;
   empty value skips always-name / merge-into; never-group ignores value.
   Matching is D-033. never-group tabs go to ungrouped. always-name / merge-into
   pull matching tabs into `rule:<value>` groups (same trimmed value = one group).
   Rule groups fill leftover `maxGroups` slots first (size desc, key asc) and may
   be smaller than `minGroupSize`. Merge of two hosts on the same site that cover
   that site is a no-op; merge is for one host or two different sites.
5. **Domain clustering** — remainder, bucket by eTLD+1, a bucket becomes a group
   at `minGroupSize` or more, using leftover `maxGroups` slots. Known services
   get real names (`GitHub`). Google splits by product and Wikipedia by title
   tokens, only when two piles each meet `minGroupSize`.
6. **Topics** — if `groupingMode` is `topics`, leftover tabs after site grouping
   are clustered by shared title tokens (same tokenizer as in-site Wikipedia).
   A token covering the whole remainder is still a topic. `minGroupSize` applies.
   Uses leftover `maxGroups` slots after site groups. Sites mode skips this.
7. Whatever is left becomes `ungrouped`.

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
   no tabs. Collapse, thresholds, duplicates, rules, grouping mode, and join
   existing are wired. Archive is applied (D-038). AI controls are saved only.
2. ~~**“Make tab groups” toggle**~~ on the popup, default on. Off = same site
   buckets, only reorder the strip (no Firefox tab-group chrome). Replaced
   Sort by domain / title.
3. ~~**Duplicates compact line**~~ — one row under groups; expand for clusters;
   close-now lives inside that block, not next to the primary button.
4. ~~**Custom domain rules**~~ — always-name / never-group / merge-into. D-033.
   Wired into `buildPlan`. Options is the editor.
5. ~~**Join existing groups**~~ — D-034. One leftover tab joins a matching
   group instead of forming a duplicate site group.
6. ~~**Cross-site topics**~~ — D-035. Title tokens over the remainder after
   domain clustering. Sites still run first. Wikipedia/Google *in-site* splits
   stay D-027.
7. ~~**Archive**~~ — D-038. Idle tabs as a normal group row. Toggle and days
   on options. One idle tab is enough. Joins an existing Archive group if present.
8. **AI** — parked (D-036). Toggle and button label exist. Nothing is sent.
   Not required for grouping across sites (topics already do that). If it
   comes back: BYOK, visible host/network permission, preview stays local.
   No paywall.

Still not in the product: per-tab exclude (D-007), survivor picker, i18n
(D-003), host permission (D-002), billing.

## Where AI goes (parked, D-036)

Topics (D-035) already cluster leftovers across sites, locally, with no
network. AI is not needed for that job. It would only help when titles share no
token (“Hotel Tivoli” + “Alfama walk” + a TAP confirmation are all a trip).
Do not add a host permission or a paywall for a feature that is not earning
its keep.

If it comes back, the locked shape still holds: an optional stage **instead of**
title clustering, on the **same input** (remainder after domain clustering).
Same output type. The popup preview is **always** the local deterministic plan
(instant, no network).

- Toggle in **options**, default off. Greyed out when offline. **BYOK** (paste
  an API key). No billing UI, no paywall.
- Request fires only on the popup **primary button**, never when the popup
  opens. Button says “Group N tabs with AI”. Undo is the safety net. Slow or
  unavailable → fall back to the local plan.
- It never sees every tab. Enabling it is a **visible** new permission /
  network event (D-002).

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

### Domain rules (D-033)

- Pattern is a hostname, not a URL, glob, or substring. Empty / whitespace skips
  the rule. Same host normalisation as `canonicalUrl` (lowercase, trailing dot,
  leading `www.` only when the rest still contains a dot).
- Pattern equals the tab host → that host only (`mail.foo.com` does not include
  `app.foo.com`). Else pattern equals the registrable domain → whole site
  (`github.com` includes `gist.github.com`). Else no match. Host match beats
  site match when both a host rule and a site rule could apply.
- `amazon.de` is not `amazon.com`.
- never-group → ungrouped, not clustered. always-name / merge-into share a
  `rule:<value>` group for the same trimmed value. Empty value skips those two;
  never-group ignores value. Rule groups may be smaller than `minGroupSize`.
- Merge of two hosts on the same site that cover that site is a no-op vs default
  site grouping. Merge of one host, or of two different sites, is not.
- Rule groups fill `maxGroups` first; leftover slots go to domain clustering.
- Duplicates still run first: closed tabs never appear in a rule group.

### Join existing groups (D-034)

- One loose tab is enough. `minGroupSize` does not apply to joins.
- Match host, then Google product, then site. never-group never joins.
- Two existing GitHub groups: larger wins, then lower `groupId`.
- Gmail vs Docs: a Docs tab does not join a Gmail-only group.
- `amazon.de` joins an existing "Amazon" group when a merge-into / always-name
  rule uses that title, even though the sites differ.
- Join proposals do not consume `maxGroups`.
- Duplicates still run first. Apply does not retitle an existing group. Undo
  ungroups only the tabs that were added.
- Wikipedia topic groups all share `wikipedia.org`; a new article joins the
  larger one. Splitting by title token is not re-run against existing groups.

### Topics (D-035)

- Sites mode: leftovers stay ungrouped. Topics mode: same leftovers may group.
- GitHub (or any site group) is formed first and is not re-clustered by title.
- Three tabs on a.com / b.com / c.com titled around Lisbon → `topic:lisbon`.
- Two tabs sharing a token stay ungrouped (`minGroupSize`).
- Two topics each at `minGroupSize` both peel. One token covering everyone is
  still a topic (unlike in-site Wikipedia).
- Stopwords (`the`, `new`, …) never form a topic.
- never-group tabs are not in the leftover pile.
- Leftover `maxGroups` slots after site groups; larger topics kept first.

### Archive (D-038)

- Off: idle tabs still site-group. On: they become one Archive row, even below
  `minGroupSize`.
- Fresh tabs (`lastAccessed` within `archiveDays`) stay in the rest of the plan.
- never-group tabs are not archived.
- An existing group titled Archive is extended, not duplicated.
- Duplicates still run first.
- `now - lastAccessed >= archiveDays` days. `lastAccessed` 0 plus a real `now`
  counts as idle. The `npm run dev` tab `https://example.net/old` is reported
  as 0 in the adapter so Archive does not need a real day of waiting.

### Duplicates

- three tabs on the same canonical URL -> keep one, close two
- the kept tab is the one with the lowest index, deterministically
- a duplicate tab must not also appear in a group proposal
- a spared cluster stays in `duplicates` with `spare: true`; its close-tabs
  appear in groups and do not count toward `wouldClose`

## Known bugs

- **1×1 white-dot popup.** Firefox sizes the action popup with
  `getContentSize` on a preload browser (shown after at most 200ms). It
  **ignores `min-height`**. If the first size is under ~30×10, it writes
  width/height onto the XUL browser; later resizes are then circular with a
  1px viewport. Cause during “Reading tabs…”: boot CSS had no real `height`,
  and a render-blocking `<link>` to `style.css` delayed DOMContentLoaded past
  the 200ms timeout. **Fix (D-031):** `body { height: 120px }` (the mock
  loading size) until `#root` has content, then `height: auto`. Import CSS
  from `main.tsx`, not a blocking `<link>`. Still no viewport meta, no 240px
  lock, no `fit.js`. After HTML/JS changes, reload the add-on.

## Next UI (D-029, shipped chrome)

UX over polish. Popup = this window’s plan + one confirm. Options = the rest.
Native Firefox panel (system-ui, light/dark panel colours). ~380px wide, height
follows content, max ~600. One scroller for lists; header/gear/actions stay.

**Popup first glance:** groups (checkbox, colour, name, reason,
expand titles). All/None only if 2+ groups. Quiet leftovers line. Archive,
when enabled, is just another group row. Gear top-right → options.

**Duplicates:** one compact line (“N duplicates, close on apply”);
expand for clusters; close-now inside that block.

**Primary:** one button (“Group N tabs” / “Reorder N tabs” / “Close N
duplicates” / “Group N tabs with AI” if the options toggle is on). Cancel.
Quiet Undo if a snapshot exists. “Make tab groups” toggle near the primary
action, default on.

**Not on the main popup:** collapse checkbox, sort buttons, equal-weight
Group/Close/Sort row, grouping-mode segmented control, thresholds.

**Options:** one page, headings in this order — Grouping (sites default /
topics across leftovers), AI (off, offline-disabled), New groups (collapse),
Thresholds, Duplicates, Archive, Rules (host or site, not “domain or pattern”).

**States to keep:** loading (HTML spinner), working, empty, applied + undo,
error / Firefox too old.

## Decisions

Newest first. One line each; a paragraph only when the reasoning is not obvious.

- **D-038 (2026-08-29)** — Archive peels idle tabs after duplicates and before
  join. `now` is a parameter. One idle tab is enough. never-group wins.
  `lastAccessed` 0 is very long ago. Join an existing group titled Archive
  rather than creating a second one. Counts toward maxGroups.
- **D-037 (2026-08-29)** — The popup does not grow a “create group” control.
  Firefox already groups tabs. This add-on proposes a plan; uncheck is the
  edit. Manual grouping stays native (D-005, D-007).
- **D-036 (2026-08-29)** — AI is parked. Topics already group leftovers across
  sites. Do not add a host permission or a paywall for that. If AI returns, it
  is BYOK, apply-time only, preview stays local (amends the D-029 AI toggle:
  the control can stay; it does not ship a network stage).
- **D-035 (2026-08-29)** — Topics cluster leftovers by title after site grouping.
  Sites stay the default. Same tokenizer as in-site Wikipedia (D-027), but a
  token covering the whole remainder is still a topic. When tokens tie on size,
  prefer the one that is the first title token of more members, then code units.
  `minGroupSize` applies; leftover `maxGroups` slots after site groups. never-group
  tabs do not join a topic.
- **D-034 (2026-08-29)** — Loose tabs join existing groups instead of forming a
  second group of the same site. One tab is enough. Already-grouped tabs still
  never reach core as TabInfo (D-005); the adapter passes group fingerprints.
  Apply uses `tabs.group({ groupId })` and does not change that group's title,
  colour, or collapsed state. Undo ungroups only the added tabs. Amends D-005
  (still no regrouping of members) and D-022 (existing groups are extended, not
  restyled).
- **D-033 (2026-08-29)** — Domain-rule patterns are a hostname, not a URL, glob,
  or substring. Empty pattern skips the rule. Normalise like `url.ts`. Host match
  (pattern equals tab host) beats site match (pattern equals eTLD+1). amazon.de
  is not amazon.com. Merge of two hosts on the same site is a no-op; merge is for
  one host or two different sites. Rules run after duplicates, before domain
  clustering; they win over Sites. Rule groups fill maxGroups first and may be
  smaller than minGroupSize.
- **D-032 (2026-08-29)** — Popup light/dark uses the mock’s panel tokens
  (`#ffffff` / `#2b2a33`) and sets `color-scheme` on `:root`, not `Canvas`.
  In the action popup `Canvas` often stays light, so the panel never flips.
  Options stays a content tab (`Canvas` + `prefers-color-scheme`) and the
  720px column is centered. Amends D-029.
- **D-031 (2026-08-28)** — Firefox ignores `min-height` in popup
  `getContentSize`; the first used size must be a real `height`. Boot the
  body at 120px (loading mock), drop to `auto` when React paints. Do not
  `<link>` `style.css` from the popup HTML — that blocks DOMContentLoaded
  past the 200ms preload timeout. Amends D-028 (still no 240px lock) and
  D-030 (`min-width: 0` was not the loading-phase cause).
- **D-030 (2026-08-28)** — First paint must not be shrink-to-fit collapsible.
  D-029’s header `min-width: 0` let Firefox’s first `getContentSize` come back
  ~1×1 while `#boot` was still showing, and the panel never grew. Keep
  `min-width: 380px` on `body` and `.shell`, `min-height: 48px` on `#boot`; do
  not pin popup height. Amends D-028 (still no height pin, still no viewport)
  and D-029.
- **D-029 (2026-08-28)** — Popup redesign. UX > decoration. Groups are the
  first glance; one primary apply. Duplicates are a compact expandable line.
  Drop Sort by domain/title; replace with “Make tab groups” (default on; off
  = reorder only). Settings and mode live on an options page opened from a
  header gear. AI is an options toggle, default off (parked, D-036); if it
  ever runs, request on Apply, preview stays local. Archive is a normal group
  row when the stage exists. Native Firefox chrome. Amends D-020 (duplicates
  still per-cluster in the data, quieter in the UI), D-022 (collapse moved
  to options), D-027 (sort left the popup).
- **D-028 (2026-08-27)** — The HTML file *is* the loading screen. React does
  not mount until tabs are read (`loadPopup` then `createRoot`); the first
  commit is already the preview (never `null`). `#boot` sits outside `#root`
  and hides when React paints. Popup height tracks content; **do not pin
  it.** Width stays on `body`, not `:root`. No viewport meta. The header
  gear is a link to `options.html` plus classic `open-options.js` (publicDir,
  not the popup module) so it works during “Reading tabs…”, before Vite has
  loaded `main.tsx`. Amends D-026.
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
  don't second-guess it. Amended by D-034: those groups are still not regrouped,
  but loose tabs can join them. `TabInfo` still has no `groupId`.
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
