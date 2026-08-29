import { type Browser, browser } from "wxt/browser";
import type { GroupColor, GroupPlan } from "@/core/types";

/**
 * The only file that changes anything about the browser. It performs a plan; it
 * never decides one.
 *
 * The single judgement call in here is about drift: the plan was computed from a
 * snapshot of the tab strip, and the user may have closed a tab since. Every
 * write is therefore filtered against the tabs that still exist, so an apply
 * degrades to doing less rather than failing.
 */

/**
 * Compile-time proof that our hand-written palette is a subset of what the
 * browser accepts. If `GroupColor` ever grows a colour `tabGroups` does not
 * know, this stops compiling — which is the whole point of it being a function
 * on the way in rather than a comment in types.ts.
 */
function toBrowserColor(color: GroupColor): `${Browser.tabGroups.Color}` {
  return color;
}

/**
 * What one apply changed, and everything `restore` needs to take it back.
 *
 * Closed tabs are recorded by URL, not by id: undo reopens them as *new* tabs,
 * so history and scroll position are gone (D-006). Grouped tabs also keep the
 * positions grouping gave them — undo dissolves the groups, it does not put the
 * tab strip back in its old order.
 */
export type Snapshot = {
  windowId: number;
  createdAt: number;
  createdGroups: { groupId: number; tabIds: number[] }[];
  closedTabs: { url: string; index: number }[];
};

export type ApplyResult = {
  snapshot: Snapshot;
  /** Keys of proposals the browser refused. Everything else still applied. */
  failedKeys: string[];
};

type LiveTab = { url: string; index: number };

/**
 * Whether this build has tab groups at all.
 *
 * `strict_min_version: 139` means the only Firefox reaching this check without
 * the API is a fork. One honest message beats a capability abstraction (D-008).
 */
export function supportsTabGroups(): boolean {
  return typeof browser.tabs.group === "function" && typeof browser.tabGroups === "object";
}

/** The tabs of `windowId` as they exist right now, by id. */
async function readLiveTabs(windowId: number): Promise<Map<number, LiveTab>> {
  const live = new Map<number, LiveTab>();

  for (const tab of await browser.tabs.query({ windowId })) {
    if (tab.id === undefined) continue;
    live.set(tab.id, { url: tab.url ?? "", index: tab.index });
  }

  return live;
}

/** `tabs.group` wants a non-empty tuple. This is that guarantee, without a cast. */
function nonEmpty(ids: number[]): [number, ...number[]] | null {
  const [first, ...rest] = ids;
  return first === undefined ? null : [first, ...rest];
}

/**
 * Closes what the plan marked as duplicates and returns exactly what closed.
 *
 * "Exactly" is the contract that matters: a snapshot claiming to have closed a
 * tab that is in fact still open would open a second copy of it on undo.
 */
async function closeTabs(
  ids: readonly number[],
  live: ReadonlyMap<number, LiveTab>,
): Promise<Snapshot["closedTabs"]> {
  const targets: { id: number; url: string; index: number }[] = [];

  for (const id of ids) {
    const tab = live.get(id);
    // Already gone, or no URL to reopen it from. Closing a tab we could not
    // bring back is the one thing this extension must never do.
    if (tab === undefined || tab.url === "") continue;
    targets.push({ id, url: tab.url, index: tab.index });
  }

  if (targets.length === 0) return [];

  const record = ({ url, index }: { url: string; index: number }) => ({ url, index });

  try {
    await browser.tabs.remove(targets.map((target) => target.id));
    return targets.map(record);
  } catch {
    // One stale id rejects the whole batch, so retry one at a time and keep only
    // what actually closed.
    const closed: Snapshot["closedTabs"] = [];

    for (const target of targets) {
      try {
        await browser.tabs.remove([target.id]);
        closed.push(record(target));
      } catch {
        // Still open. Nothing happened, so there is nothing to undo.
      }
    }

    return closed;
  }
}

/**
 * Performs `plan`, minus the proposals the user unchecked.
 *
 * Guarantees: never touches a tab the plan did not name, never closes a tab it
 * cannot reopen, and returns a snapshot that describes what actually happened —
 * not what was asked for. A proposal the browser refuses is reported in
 * `failedKeys` and does not abort the rest. Spared duplicate clusters are not
 * closed. Newly created groups are collapsed when `options.collapse` is true.
 * Tabs added to an existing group do not change that group's title, colour, or
 * collapsed state (D-022, D-034).
 */
export async function applyPlan(
  plan: GroupPlan,
  excludedKeys: readonly string[],
  options: { collapse: boolean },
): Promise<ApplyResult> {
  const excluded = new Set(excludedKeys);
  const live = await readLiveTabs(plan.windowId);

  // Duplicates first: their indices are recorded before grouping reshuffles the
  // strip, which is what makes reopening them land roughly where they were.
  const closedTabs = await closeTabs(
    plan.duplicates.filter((cluster) => !cluster.spare).flatMap((cluster) => cluster.close),
    live,
  );

  const createdGroups: Snapshot["createdGroups"] = [];
  const failedKeys: string[] = [];

  for (const group of plan.groups) {
    if (excluded.has(group.key)) continue;

    const tabIds = nonEmpty(group.tabIds.filter((id) => live.has(id)));
    if (tabIds === null) continue;

    // Sequential on purpose. Concurrent tabs.group() calls interleave the moves
    // they make in the tab strip, and a dozen round trips is not a bottleneck.
    let groupId: number;
    try {
      if (group.existingGroupId !== undefined) {
        groupId = await browser.tabs.group({ groupId: group.existingGroupId, tabIds });
      } else {
        groupId = await browser.tabs.group({
          createProperties: { windowId: plan.windowId },
          tabIds,
        });
      }
    } catch {
      failedKeys.push(group.key);
      continue;
    }

    // Recorded before the title is set: the tabs are grouped either way, and undo
    // has to know about a group that came out nameless. For joins, undo ungroups
    // only these tabs — the existing group's other members stay put (D-034).
    createdGroups.push({ groupId, tabIds });

    if (group.existingGroupId !== undefined) continue;

    try {
      await browser.tabGroups.update(groupId, {
        title: group.label,
        color: toBrowserColor(group.color),
        collapsed: options.collapse,
      });
    } catch {
      // The group exists with the browser's default title, colour, and
      // expanded/collapsed state. Cosmetic, and not worth reporting an apply
      // that visibly worked as failed.
    }
  }

  return {
    snapshot: { windowId: plan.windowId, createdAt: Date.now(), createdGroups, closedTabs },
    failedKeys,
  };
}

/**
 * Takes back what `applyPlan` did: dissolves the groups it created and reopens
 * the tabs it closed.
 *
 * Not restored: tab order, and the history and scroll position of reopened tabs.
 * Errors propagate — an undo that half-worked is something the user needs told,
 * not something to swallow.
 */
export async function restore(snapshot: Snapshot): Promise<void> {
  const live = await readLiveTabs(snapshot.windowId);

  for (const group of snapshot.createdGroups) {
    const tabIds = nonEmpty(group.tabIds.filter((id) => live.has(id)));
    if (tabIds === null) continue;

    // No removeGroup in the API, and none needed: a group disappears when its
    // last tab leaves it.
    await browser.tabs.ungroup(tabIds);
  }

  // Ascending index, so each reopened tab lands in the gap the previous one just
  // shifted into place. Positions are approximate — the strip moved since.
  for (const closed of [...snapshot.closedTabs].sort((a, b) => a.index - b.index)) {
    await browser.tabs.create({
      windowId: snapshot.windowId,
      url: closed.url,
      index: closed.index,
      active: false,
    });
  }
}
