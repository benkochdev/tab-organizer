import { useState } from "react";
import { buildPlan } from "@/core/plan";
import type {
  Config,
  DuplicateCluster,
  ExistingGroup,
  GroupColor,
  GroupPlan,
  GroupProposal,
  TabInfo,
} from "@/core/types";
import {
  type ApplyResult,
  applyPlan,
  restore,
  type Snapshot,
  supportsTabGroups,
} from "@/platform/apply";
import {
  DEFAULT_UI_SETTINGS,
  loadUiSettings,
  saveUiSettings,
  type UiSettings,
} from "@/platform/settings";
import { clearSnapshot, loadSnapshotMap, saveSnapshot } from "@/platform/storage";
import { readCurrentWindow, sortOrganisableTabs } from "@/platform/tabs";

/**
 * Approximations of the tabGroups palette, for the preview dot only. The real
 * colour is applied by the browser on apply; this just has to be recognisable.
 */
const SWATCH: Record<GroupColor, string> = {
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#22c55e",
  grey: "#9ca3af",
  orange: "#f97316",
  pink: "#ec4899",
  purple: "#a855f7",
  red: "#ef4444",
  yellow: "#eab308",
};

type Phase =
  | { status: "unsupported" }
  | { status: "ready"; windowId: number; tabs: TabInfo[]; existingGroups: ExistingGroup[] }
  | { status: "working"; label: string }
  | {
      status: "applied";
      result: ApplyResult | null;
      failedLabels: string[];
      reorderedCount: number;
    }
  | { status: "failed"; message: string };

/** What `loadPopup` hands `App` so the first React commit is already a real screen. */
export type Start =
  | { kind: "unsupported" }
  | { kind: "failed"; message: string }
  | {
      kind: "ok";
      windowId: number;
      tabs: TabInfo[];
      existingGroups: ExistingGroup[];
      snapshot: Snapshot | null;
      settings: UiSettings;
    };

type Loaded = {
  windowId: number;
  tabs: TabInfo[];
  existingGroups: ExistingGroup[];
  snapshot: Snapshot | null;
  settings: UiSettings;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function tabLabel(tab: TabInfo): string {
  return tab.title === "" ? tab.url : tab.title;
}

function lookup(byId: ReadonlyMap<number, TabInfo>, ids: readonly number[]): TabInfo[] {
  return ids.flatMap((id) => {
    const tab = byId.get(id);
    return tab === undefined ? [] : [tab];
  });
}

/**
 * Loose-tab order for "Make tab groups" off: selected groups packed in plan
 * order, everything else after that in strip order. Closing duplicates are
 * omitted — they will not exist after apply.
 */
function reorderIds(
  plan: GroupPlan,
  excluded: ReadonlySet<string>,
  tabs: readonly TabInfo[],
): number[] {
  const packed = plan.groups
    .filter((group) => !excluded.has(group.key))
    .flatMap((group) => group.tabIds);
  const packedSet = new Set(packed);
  const closing = new Set(
    plan.duplicates.filter((cluster) => !cluster.spare).flatMap((cluster) => cluster.close),
  );
  const rest = [...tabs]
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id)
    .filter((id) => !packedSet.has(id) && !closing.has(id));
  return [...packed, ...rest];
}

function appliedSummary(args: { result: ApplyResult | null; reorderedCount: number }): string {
  const groups = args.result?.snapshot.createdGroups.length ?? 0;
  const groupedTabs =
    args.result?.snapshot.createdGroups.reduce((total, group) => total + group.tabIds.length, 0) ??
    0;
  const closed = args.result?.snapshot.closedTabs.length ?? 0;

  if (args.reorderedCount > 0) {
    const reorder = `Reordered ${plural(args.reorderedCount, "tab", "tabs")}`;
    return closed > 0
      ? `${reorder} and closed ${plural(closed, "duplicate", "duplicates")}.`
      : `${reorder}.`;
  }

  if (groups === 0 && closed === 0) return "Nothing changed.";
  if (groups === 0) return `Closed ${plural(closed, "duplicate", "duplicates")}.`;

  const grouped = `Grouped ${plural(groupedTabs, "tab", "tabs")} into ${plural(groups, "group", "groups")}`;
  return closed > 0
    ? `${grouped} and closed ${plural(closed, "duplicate", "duplicates")}.`
    : `${grouped}.`;
}

/**
 * Reads tabs and settings before React mounts.
 *
 * Guarantees the HTML loading screen is the only UI until this resolves, so
 * `createRoot` never paints an empty `#root`.
 */
export async function loadPopup(): Promise<Start> {
  if (!supportsTabGroups()) return { kind: "unsupported" };

  try {
    const loaded = await readState();
    return { kind: "ok", ...loaded };
  } catch (error: unknown) {
    return { kind: "failed", message: describe(error) };
  }
}

/**
 * One read of the world: the window's organisable tabs, an undo snapshot for
 * this window if there is one, and options. Reads only — the popup is reopened
 * after every apply and has to be able to run this at any time.
 */
async function readState(): Promise<Loaded> {
  const [{ windowId, tabs, existingGroups }, snapshots, settings] = await Promise.all([
    readCurrentWindow(),
    loadSnapshotMap(),
    loadUiSettings(),
  ]);

  return {
    windowId,
    tabs,
    existingGroups,
    snapshot: snapshots.get(windowId) ?? null,
    settings,
  };
}

function Busy({ label }: { label: string }) {
  return (
    <div className="busy" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="chevron-icon"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      style={{ transform: `rotate(${open ? 90 : 0}deg)` }}
    >
      <path d="M4 2.5 L8 6 L4 9.5" />
    </svg>
  );
}

function Actions({
  undoable,
  undoLabel,
  onUndo,
  primary,
  onPrimary,
}: {
  undoable: Snapshot | null;
  undoLabel: string;
  onUndo: () => void;
  primary: string;
  onPrimary: () => void;
}) {
  return (
    <div className="actions bar">
      {undoable !== null && (
        <button type="button" className="link quiet" onClick={onUndo}>
          {undoLabel}
        </button>
      )}
      <span className="spacer" />
      <button type="button" className="primary" onClick={onPrimary}>
        {primary}
      </button>
    </div>
  );
}

/**
 * One proposed group. Expanding it lists the tabs by title, because "12 tabs
 * from github.com" is a claim, and the user should be able to check it before
 * agreeing to it rather than after.
 */
function GroupRow({
  group,
  tabs,
  selected,
  expanded,
  onSelect,
  onExpand,
}: {
  group: GroupProposal;
  tabs: TabInfo[];
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onExpand: () => void;
}) {
  return (
    <li className="row">
      <div className="row-head">
        <label className="row-main">
          <input type="checkbox" checked={selected} onChange={onSelect} />
          <span className="dot" style={{ background: SWATCH[group.color] }} />
          <div className="row-copy">
            <div className="row-name">{group.label}</div>
            <div className="row-reason">{group.reason}</div>
          </div>
        </label>
        <button
          type="button"
          className="chevron"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide tabs in ${group.label}` : `Show tabs in ${group.label}`}
          onClick={onExpand}
        >
          <Chevron open={expanded} />
        </button>
      </div>
      {expanded && (
        <ul className="tab-list">
          {tabs.map((tab) => (
            <li key={tab.id} title={tab.url}>
              {tabLabel(tab)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function DuplicateClusterRow({
  cluster,
  keep,
  close,
  expanded,
  onExpand,
}: {
  cluster: DuplicateCluster;
  keep: TabInfo | undefined;
  close: TabInfo[];
  expanded: boolean;
  onExpand: () => void;
}) {
  const label = keep === undefined ? cluster.canonicalUrl : tabLabel(keep);
  const reason = `${plural(cluster.close.length, "copy", "copies")} to close`;

  return (
    <div className="cluster">
      <div className="cluster-head">
        <div className="cluster-copy">
          <div className="cluster-title">{label}</div>
          <div className="cluster-count">{reason}</div>
        </div>
        <button
          type="button"
          className="chevron small"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide copies of ${label}` : `Show copies of ${label}`}
          onClick={onExpand}
        >
          <Chevron open={expanded} />
        </button>
      </div>
      {expanded && (
        <ul className="tab-list inset">
          {keep !== undefined && (
            <li key={keep.id} title={keep.url}>
              Keep {tabLabel(keep)}
            </li>
          )}
          {close.map((tab) => (
            <li key={tab.id} title={tab.url}>
              Close {tabLabel(tab)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function initialPhase(start: Start): Phase {
  if (start.kind === "ok") {
    return {
      status: "ready",
      windowId: start.windowId,
      tabs: start.tabs,
      existingGroups: start.existingGroups,
    };
  }
  if (start.kind === "unsupported") return { status: "unsupported" };
  return { status: "failed", message: start.message };
}

export function App({ start }: { start: Start }) {
  const [phase, setPhase] = useState<Phase>(() => initialPhase(start));
  const [undoable, setUndoable] = useState<Snapshot | null>(
    start.kind === "ok" ? start.snapshot : null,
  );
  const [settings, setSettings] = useState<UiSettings>(
    start.kind === "ok" ? start.settings : DEFAULT_UI_SETTINGS,
  );
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [spared, setSpared] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [ungroupedOpen, setUngroupedOpen] = useState(false);
  const [dupsOpen, setDupsOpen] = useState(false);

  async function persist(patch: Partial<UiSettings>): Promise<void> {
    setSettings((current) => ({ ...current, ...patch }));
    try {
      await saveUiSettings(patch);
    } catch {
      // Preference did not stick; this apply still honours the control.
    }
  }

  async function handleApply(plan: GroupPlan, grouping: boolean): Promise<void> {
    if (phase.status !== "ready") return;

    const { windowId, tabs } = phase;
    const selectedGroups = plan.groups.filter((group) => !excluded.has(group.key));
    const movingTabs = selectedGroups.reduce((total, group) => total + group.tabIds.length, 0);
    const willGroup = grouping && selectedGroups.length > 0;
    const willReorder = !grouping && selectedGroups.length > 0;
    const willClose = plan.stats.wouldClose > 0;

    setPhase({
      status: "working",
      label: willGroup
        ? "Grouping tabs…"
        : willReorder
          ? "Reordering tabs…"
          : "Closing duplicates…",
    });

    try {
      let result: ApplyResult | null = null;
      if (willGroup || willClose) {
        const excludedKeys = willGroup ? [...excluded] : plan.groups.map((group) => group.key);
        result = await applyPlan(plan, excludedKeys, { collapse: settings.collapseNewGroups });
      }

      if (willReorder) {
        await sortOrganisableTabs(windowId, reorderIds(plan, excluded, tabs));
      }

      const snapshot = result?.snapshot;
      const changed =
        snapshot !== undefined &&
        (snapshot.createdGroups.length > 0 || snapshot.closedTabs.length > 0);

      if (changed && snapshot !== undefined) await saveSnapshot(snapshot);

      const failedLabels = (result?.failedKeys ?? []).map((key) => {
        const group = plan.groups.find((proposal) => proposal.key === key);
        return group === undefined ? key : group.label;
      });

      setUndoable(changed && snapshot !== undefined ? snapshot : undoable);
      setPhase({
        status: "applied",
        result,
        failedLabels,
        reorderedCount: willReorder ? movingTabs : 0,
      });
    } catch (error: unknown) {
      setPhase({ status: "failed", message: describe(error) });
    }
  }

  async function handleCloseDuplicates(plan: GroupPlan): Promise<void> {
    setPhase({ status: "working", label: "Closing duplicates…" });
    try {
      const result = await applyPlan(
        plan,
        plan.groups.map((group) => group.key),
        { collapse: settings.collapseNewGroups },
      );
      const changed = result.snapshot.closedTabs.length > 0;
      if (changed) await saveSnapshot(result.snapshot);
      setUndoable(changed ? result.snapshot : undoable);
      setPhase({ status: "applied", result, failedLabels: [], reorderedCount: 0 });
    } catch (error: unknown) {
      setPhase({ status: "failed", message: describe(error) });
    }
  }

  async function handleUndo(snapshot: Snapshot): Promise<void> {
    setPhase({ status: "working", label: "Undoing…" });

    try {
      await restore(snapshot);
      await clearSnapshot(snapshot.windowId);
      setUndoable(null);
      setExcluded(new Set());
      setSpared(new Set());

      const loaded = await readState();
      setSettings(loaded.settings);
      setPhase({
        status: "ready",
        windowId: loaded.windowId,
        tabs: loaded.tabs,
        existingGroups: loaded.existingGroups,
      });
    } catch (error: unknown) {
      setPhase({ status: "failed", message: describe(error) });
    }
  }

  function toggle(
    set: ReadonlySet<string>,
    update: (next: ReadonlySet<string>) => void,
    key: string,
  ): void {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    update(next);
  }

  function closeWindow(): void {
    window.close();
  }

  if (phase.status === "working") {
    return <Busy label={phase.label} />;
  }

  if (phase.status === "unsupported") {
    return (
      <>
        <div className="message">
          <p>Tab groups need Firefox 139 or later.</p>
          <p className="hint">Disable Make tab groups to sort tabs without grouping.</p>
        </div>
        <Actions
          undoable={undoable}
          undoLabel="Undo last apply"
          onUndo={() => undoable !== null && void handleUndo(undoable)}
          primary="Close"
          onPrimary={closeWindow}
        />
      </>
    );
  }

  if (phase.status === "failed") {
    return (
      <>
        <div className="message">
          <p>Error: {phase.message}</p>
        </div>
        <Actions
          undoable={undoable}
          undoLabel="Undo last apply"
          onUndo={() => undoable !== null && void handleUndo(undoable)}
          primary="Close"
          onPrimary={closeWindow}
        />
      </>
    );
  }

  if (phase.status === "applied") {
    return (
      <>
        <div className="message">
          <p>{appliedSummary(phase)}</p>
          {phase.failedLabels.length > 0 && (
            <p className="hint">{phase.failedLabels.join(", ")} were not grouped.</p>
          )}
        </div>
        <Actions
          undoable={undoable}
          undoLabel="Undo"
          onUndo={() => undoable !== null && void handleUndo(undoable)}
          primary="Close"
          onPrimary={closeWindow}
        />
      </>
    );
  }

  const config: Config = {
    minGroupSize: settings.minGroupSize,
    maxGroups: settings.maxGroups,
    detectDuplicates: settings.detectDuplicates,
    spareDuplicateCanonicals: [...spared],
    rules: settings.rules.map((rule) => ({
      pattern: rule.pattern,
      action: rule.action,
      value: rule.value,
    })),
  };
  const plan = buildPlan(phase.windowId, phase.tabs, config, phase.existingGroups);

  const byId = new Map(phase.tabs.map((tab) => [tab.id, tab]));
  const selected = plan.groups.filter((group) => !excluded.has(group.key));
  const movingTabs = selected.reduce((total, group) => total + group.tabIds.length, 0);
  const closing = plan.stats.wouldClose;
  const dupsOn = plan.duplicates.some((cluster) => !cluster.spare);
  const nothingToDo = movingTabs === 0 && closing === 0;
  const hasGroups = plan.groups.length > 0;
  const hasDuplicates = plan.duplicates.length > 0;
  const hasUngrouped = plan.ungrouped.length > 0;
  const hasPlan = hasGroups || hasDuplicates;
  const grouping = settings.makeTabGroups;
  const useAi = settings.useAi && grouping && navigator.onLine;

  const actionLabel = (() => {
    if (movingTabs > 0 && grouping) {
      return `Group ${plural(movingTabs, "tab", "tabs")}${useAi ? " with AI" : ""}`;
    }
    if (movingTabs > 0) return `Reorder ${plural(movingTabs, "tab", "tabs")}`;
    if (closing > 0) return `Close ${plural(closing, "duplicate", "duplicates")}`;
    return "Nothing selected";
  })();

  const undoCount = undoable?.createdGroups.length ?? 0;
  const undoLabel =
    undoCount > 0 ? `Undo last apply (${plural(undoCount, "group", "groups")})` : "Undo last apply";

  if (!hasPlan) {
    return (
      <>
        <div className="message">
          <p>No groups in this window.</p>
          <p className="hint">
            {phase.tabs.length === 0
              ? "No ungrouped tabs in this window."
              : `${plural(phase.tabs.length, "tab", "tabs")}. No domain has ${settings.minGroupSize} or more.`}
          </p>
        </div>
        <div className="actions bar">
          <span className="spacer" />
          <button type="button" onClick={closeWindow}>
            Cancel
          </button>
        </div>
      </>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleApply(plan, grouping);
      }}
    >
      <div className="plan-body">
        {hasGroups && (
          <>
            <div className="plan-head">
              <span className="plan-head-label">Groups</span>
              {plan.groups.length > 1 && (
                <span className="pick">
                  <button type="button" className="link" onClick={() => setExcluded(new Set())}>
                    All
                  </button>
                  <span>/</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setExcluded(new Set(plan.groups.map((group) => group.key)))}
                  >
                    None
                  </button>
                </span>
              )}
            </div>
            <ul className="plan-list">
              {plan.groups.map((group) => (
                <GroupRow
                  key={group.key}
                  group={group}
                  tabs={lookup(byId, group.tabIds)}
                  selected={!excluded.has(group.key)}
                  expanded={expanded.has(group.key)}
                  onSelect={() => toggle(excluded, setExcluded, group.key)}
                  onExpand={() => toggle(expanded, setExpanded, group.key)}
                />
              ))}
            </ul>
          </>
        )}

        {hasUngrouped && (
          <div className="row">
            <div className="row-head quiet">
              <div className="row-quiet">
                {plural(plan.ungrouped.length, "ungrouped tab", "ungrouped tabs")}
              </div>
              <button
                type="button"
                className="chevron"
                aria-expanded={ungroupedOpen}
                aria-label={ungroupedOpen ? "Hide ungrouped tabs" : "Show ungrouped tabs"}
                onClick={() => setUngroupedOpen(!ungroupedOpen)}
              >
                <Chevron open={ungroupedOpen} />
              </button>
            </div>
            {ungroupedOpen && (
              <ul className="tab-list inset">
                {lookup(byId, plan.ungrouped).map((tab) => (
                  <li key={tab.id} title={tab.url}>
                    {tabLabel(tab)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {hasDuplicates && (
          <div className="row">
            <div className="row-head quiet">
              <label className="row-main">
                <input
                  type="checkbox"
                  checked={dupsOn}
                  onChange={() => {
                    if (dupsOn) {
                      setSpared(new Set(plan.duplicates.map((cluster) => cluster.canonicalUrl)));
                    } else {
                      setSpared(new Set());
                    }
                  }}
                />
                <div className="row-quiet">
                  {plural(
                    dupsOn
                      ? closing
                      : plan.duplicates.reduce((total, cluster) => total + cluster.close.length, 0),
                    "duplicate",
                    "duplicates",
                  )}
                  {dupsOn ? ", close on apply" : ", keep"}
                </div>
              </label>
              <button
                type="button"
                className="chevron"
                aria-expanded={dupsOpen}
                aria-label={dupsOpen ? "Hide duplicates" : "Show duplicates"}
                onClick={() => setDupsOpen(!dupsOpen)}
              >
                <Chevron open={dupsOpen} />
              </button>
            </div>
            {dupsOpen && (
              <div className="clusters">
                {plan.duplicates.map((cluster) => (
                  <DuplicateClusterRow
                    key={cluster.canonicalUrl}
                    cluster={cluster}
                    keep={byId.get(cluster.keep)}
                    close={lookup(byId, cluster.close)}
                    expanded={expanded.has(cluster.canonicalUrl)}
                    onExpand={() => toggle(expanded, setExpanded, cluster.canonicalUrl)}
                  />
                ))}
                {dupsOn && (
                  <div className="dups-now">
                    <button
                      type="button"
                      className="link quiet"
                      onClick={() => void handleCloseDuplicates(plan)}
                    >
                      Close {plural(closing, "duplicate", "duplicates")} now
                    </button>
                    <span className="skip">does not group</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="foot">
        <label className="toggle">
          <input
            type="checkbox"
            checked={grouping}
            onChange={(event) => void persist({ makeTabGroups: event.target.checked })}
          />
          <span>{grouping ? "Make tab groups" : "Make tab groups off. Sort only."}</span>
        </label>
        <div className="actions">
          <button type="submit" className="primary grow" disabled={nothingToDo}>
            {actionLabel}
          </button>
          <button type="button" onClick={closeWindow}>
            Cancel
          </button>
        </div>
        {undoable !== null && (
          <div>
            <button type="button" className="link quiet" onClick={() => void handleUndo(undoable)}>
              {undoLabel}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
