import { type Browser, browser } from "wxt/browser";
import type { ExistingGroup, GroupColor, TabInfo } from "@/core/types";
import { isIdleFixtureUrl } from "./idle-fixture";

/**
 * Reading tabs out of the browser and into plain data. This file decides
 * *nothing* about grouping — its only judgement call is which tabs the core is
 * allowed to see at all.
 */

/**
 * Schemes we can neither group nor move. Firefox rejects the operation, so these
 * are filtered here rather than discovered as a rejected promise mid-apply.
 */
const PRIVILEGED_SCHEMES: readonly string[] = [
  "about:",
  "moz-extension:",
  "chrome:",
  "view-source:",
  "file:",
  "data:",
  "javascript:",
];

/** The tabGroups API's "this tab is in no group" sentinel. */
const TAB_GROUP_ID_NONE = -1;

const GROUP_COLORS: readonly GroupColor[] = [
  "blue",
  "cyan",
  "green",
  "grey",
  "orange",
  "pink",
  "purple",
  "red",
  "yellow",
];

function parseGroupColor(value: string): GroupColor {
  for (const color of GROUP_COLORS) {
    if (color === value) return color;
  }
  return "grey";
}

function isPrivileged(url: string): boolean {
  return PRIVILEGED_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * Firefox's lastAccessed is read-only. The `npm run dev` fixture tab is
 * reported as 0 (very long ago) so Archive can be clicked through without
 * waiting a day. Production builds pass the browser value through.
 */
function lastAccessedOf(tab: Browser.tabs.Tab): number {
  if (import.meta.env.DEV && tab.url !== undefined && isIdleFixtureUrl(tab.url)) {
    return 0;
  }
  return tab.lastAccessed ?? 0;
}

/**
 * The tabs of a query result the core is allowed to reorganise, as plain data.
 *
 * Excluded, and each for a different reason: pinned tabs (the user placed them
 * there on purpose), privileged URLs (the browser refuses to move them), and
 * tabs that already belong to a group (if you grouped it, that was deliberate —
 * see D-005; those groups are summarised separately so loose tabs can join them).
 */
function toTabInfo(tabs: readonly Browser.tabs.Tab[], windowId: number): TabInfo[] {
  const organisable: TabInfo[] = [];

  for (const tab of tabs) {
    // `id` and `url` are optional in the API. A tab without an id cannot be
    // grouped, and without "tabs" permission `url` would be undefined — if that
    // ever happens we want to skip the tab, not crash the popup.
    if (tab.id === undefined || tab.url === undefined) continue;
    if (tab.pinned) continue;
    if (isPrivileged(tab.url)) continue;
    if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE) continue;

    organisable.push({
      id: tab.id,
      windowId: tab.windowId ?? windowId,
      index: tab.index,
      title: tab.title ?? "",
      url: tab.url,
      // Firefox omits lastAccessed on some tabs. 0 reads as "very long ago".
      lastAccessed: lastAccessedOf(tab),
    });
  }

  return organisable;
}

/**
 * Existing tab groups in this window, as fingerprints the core can match against.
 *
 * Member tabs stay out of TabInfo (D-005). Privileged and pinned members are
 * omitted from the URL list because they are not grouping evidence.
 */
async function readExistingGroups(
  tabs: readonly Browser.tabs.Tab[],
  windowId: number,
): Promise<ExistingGroup[]> {
  if (typeof browser.tabGroups.query !== "function") return [];

  let listed: Browser.tabGroups.TabGroup[];
  try {
    listed = await browser.tabGroups.query({ windowId });
  } catch {
    return [];
  }

  const byId = new Map<number, { title: string; color: GroupColor; urls: string[] }>();
  for (const group of listed) {
    byId.set(group.id, {
      title: group.title ?? "",
      color: parseGroupColor(group.color),
      urls: [],
    });
  }

  for (const tab of tabs) {
    if (tab.groupId === undefined || tab.groupId === TAB_GROUP_ID_NONE) continue;
    const group = byId.get(tab.groupId);
    if (group === undefined) continue;
    if (tab.pinned) continue;
    if (tab.url === undefined || isPrivileged(tab.url)) continue;
    group.urls.push(tab.url);
  }

  const existing: ExistingGroup[] = [];
  for (const [id, group] of byId) {
    if (group.urls.length === 0) continue;
    existing.push({ id, title: group.title, color: group.color, urls: group.urls });
  }
  existing.sort((a, b) => a.id - b.id);
  return existing;
}

/**
 * The window the popup was opened from, plus its organisable tabs and the
 * groups already in that window.
 *
 * Exactly one tab query. Firefox serialises every tab's URL and title across the
 * IPC boundary on each one, so asking twice — once for the window id, once for
 * the tabs — is a cost the user waits through while the popup sits empty.
 */
export async function readCurrentWindow(): Promise<{
  windowId: number;
  tabs: TabInfo[];
  existingGroups: ExistingGroup[];
}> {
  const all = await browser.tabs.query({ currentWindow: true });
  const windowId = all[0]?.windowId;

  if (windowId === undefined) {
    throw new Error("No current window.");
  }

  return {
    windowId,
    tabs: toTabInfo(all, windowId),
    existingGroups: await readExistingGroups(all, windowId),
  };
}

/**
 * Moves loose tabs into `orderedIds` order, packed just after any pinned tabs.
 *
 * Does not invent an order — `orderedIds` comes from core. Grouped and pinned
 * tabs are left alone; ids that no longer exist are skipped.
 */
export async function sortOrganisableTabs(
  windowId: number,
  orderedIds: readonly number[],
): Promise<void> {
  const all = await browser.tabs.query({ windowId });
  const live = new Set(all.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
  const pinnedCount = all.filter((tab) => tab.pinned).length;
  const ids = orderedIds.filter((id) => live.has(id));
  const [first, ...rest] = ids;
  if (first === undefined) return;

  await browser.tabs.move([first, ...rest], { index: pinnedCount, windowId });
}
