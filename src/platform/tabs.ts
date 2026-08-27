import { type Browser, browser } from "wxt/browser";
import type { TabInfo } from "@/core/types";

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

function isPrivileged(url: string): boolean {
  return PRIVILEGED_SCHEMES.some((scheme) => url.startsWith(scheme));
}

/**
 * The tabs of a query result the core is allowed to reorganise, as plain data.
 *
 * Excluded, and each for a different reason: pinned tabs (the user placed them
 * there on purpose), privileged URLs (the browser refuses to move them), and
 * tabs that already belong to a group (if you grouped it, that was deliberate —
 * see D-005; this is also what makes applying twice a no-op).
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
      // Firefox omits lastAccessed on some tabs. 0 reads as "very long ago",
      // which is the safe default for a stale-tab stage that does not exist yet.
      lastAccessed: tab.lastAccessed ?? 0,
    });
  }

  return organisable;
}

/**
 * The window the popup was opened from, plus its organisable tabs.
 *
 * Exactly one query. Firefox serialises every tab's URL and title across the
 * IPC boundary on each one, so asking twice — once for the window id, once for
 * the tabs — is a cost the user waits through while the popup sits empty.
 */
export async function readCurrentWindow(): Promise<{ windowId: number; tabs: TabInfo[] }> {
  const all = await browser.tabs.query({ currentWindow: true });
  const windowId = all[0]?.windowId;

  if (windowId === undefined) {
    throw new Error("No current window — the popup is open without a window to read.");
  }

  return { windowId, tabs: toTabInfo(all, windowId) };
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
