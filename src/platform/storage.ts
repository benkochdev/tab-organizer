import { browser } from "wxt/browser";
import type { Snapshot } from "./apply";

/**
 * Where undo snapshots live between two openings of the popup.
 *
 * The popup is the whole extension (D-010), and it is destroyed the moment it
 * loses focus — which is exactly when the user looks at the result of an apply
 * and decides they hate it. `storage.session` outlives the popup and dies with
 * the browser session, which is the right lifetime for "undo the last thing".
 *
 * One snapshot per window: applying in B must not erase A's undo.
 */

const SNAPSHOTS_KEY = "undo.snapshots";
/** Pre-map format. Read on load so a mid-session upgrade does not lose undo. */
const LEGACY_KEY = "undo.snapshot";

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArrayOf<T>(value: unknown, item: (element: unknown) => element is T): value is T[] {
  return Array.isArray(value) && value.every(item);
}

function isCreatedGroup(value: unknown): value is Snapshot["createdGroups"][number] {
  return isRecord(value) && isNumber(value.groupId) && isArrayOf(value.tabIds, isNumber);
}

function isClosedTab(value: unknown): value is Snapshot["closedTabs"][number] {
  return isRecord(value) && typeof value.url === "string" && isNumber(value.index);
}

/**
 * Storage hands back `unknown`, and it is not ours: a snapshot written by an
 * older build of the extension survives a reload in dev and would otherwise be
 * trusted at face value. Anything that does not match is treated as absent.
 */
function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    isNumber(value.windowId) &&
    isNumber(value.createdAt) &&
    isArrayOf(value.createdGroups, isCreatedGroup) &&
    isArrayOf(value.closedTabs, isClosedTab)
  );
}

function isSnapshotMap(value: unknown): value is Record<string, Snapshot> {
  return isRecord(value) && Object.values(value).every(isSnapshot);
}

function toMap(value: unknown): Map<number, Snapshot> {
  const map = new Map<number, Snapshot>();
  if (isSnapshotMap(value)) {
    for (const snapshot of Object.values(value)) {
      map.set(snapshot.windowId, snapshot);
    }
  }
  return map;
}

function fromMap(map: ReadonlyMap<number, Snapshot>): Record<string, Snapshot> {
  const record: Record<string, Snapshot> = {};
  for (const snapshot of map.values()) {
    record[String(snapshot.windowId)] = snapshot;
  }
  return record;
}

/** Every window's last apply, keyed by windowId. */
export async function loadSnapshotMap(): Promise<ReadonlyMap<number, Snapshot>> {
  const stored = await browser.storage.session.get([SNAPSHOTS_KEY, LEGACY_KEY]);
  const current: unknown = stored[SNAPSHOTS_KEY];
  const map = toMap(current);

  const legacy: unknown = stored[LEGACY_KEY];
  if (map.size === 0 && isSnapshot(legacy)) {
    return new Map([[legacy.windowId, legacy]]);
  }

  return map;
}

/** Replaces that window's snapshot — only the last apply per window is undoable. */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const map = new Map(await loadSnapshotMap());
  map.set(snapshot.windowId, snapshot);
  await browser.storage.session.set({ [SNAPSHOTS_KEY]: fromMap(map) });
  await browser.storage.session.remove(LEGACY_KEY);
}

export async function clearSnapshot(windowId: number): Promise<void> {
  const map = new Map(await loadSnapshotMap());
  map.delete(windowId);

  if (map.size === 0) {
    await browser.storage.session.remove([SNAPSHOTS_KEY, LEGACY_KEY]);
    return;
  }

  await browser.storage.session.set({ [SNAPSHOTS_KEY]: fromMap(map) });
  await browser.storage.session.remove(LEGACY_KEY);
}
