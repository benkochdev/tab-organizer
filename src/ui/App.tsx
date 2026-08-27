import { useEffect, useState } from "react";
import { buildPlan } from "@/core/plan";
import { sortTabIds } from "@/core/sort";
import {
  type Config,
  DEFAULT_CONFIG,
  type DuplicateCluster,
  type GroupColor,
  type GroupPlan,
  type GroupProposal,
  type TabInfo,
} from "@/core/types";
import {
  type ApplyResult,
  applyPlan,
  restore,
  type Snapshot,
  supportsTabGroups,
} from "@/platform/apply";
import { loadUiSettings, saveUiSettings } from "@/platform/settings";
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
  | { status: "loading" }
  | { status: "unsupported" }
  | { status: "ready"; windowId: number; tabs: TabInfo[] }
  | { status: "working"; label: string }
  | { status: "applied"; result: ApplyResult; failedLabels: string[] }
  | { status: "failed"; message: string };

type Loaded = {
  windowId: number;
  tabs: TabInfo[];
  snapshot: Snapshot | null;
  collapseNewGroups: boolean;
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
 * One read of the world: the window's organisable tabs, an undo snapshot for
 * this window if there is one, and the collapse preference. Reads only — the
 * popup is reopened after every apply and has to be able to run this at any time.
 */
async function readState(): Promise<Loaded> {
  const [{ windowId, tabs }, snapshots, settings] = await Promise.all([
    readCurrentWindow(),
    loadSnapshotMap(),
    loadUiSettings(),
  ]);

  return {
    windowId,
    tabs,
    snapshot: snapshots.get(windowId) ?? null,
    collapseNewGroups: settings.collapseNewGroups,
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

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={expanded ? "chevron-icon is-open" : "chevron-icon"}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 6.5 8 11l4.5-4.5"
      />
    </svg>
  );
}

function PickAllNone({ onAll, onNone }: { onAll: () => void; onNone: () => void }) {
  return (
    <span className="pick">
      <button type="button" className="link" onClick={onAll}>
        All
      </button>
      <button type="button" className="link" onClick={onNone}>
        None
      </button>
    </span>
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
    <li className={selected ? "group" : "group group-off"}>
      <div className="group-head">
        <label className="group-main">
          <input type="checkbox" checked={selected} onChange={onSelect} />
          <span className="dot" style={{ background: SWATCH[group.color] }} />
          <span className="group-label">{group.label}</span>
          <span className="muted group-reason">{group.reason}</span>
        </label>

        <button
          type="button"
          className="chevron"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide tabs in ${group.label}` : `Show tabs in ${group.label}`}
          onClick={onExpand}
        >
          <Chevron expanded={expanded} />
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

/**
 * One duplicate cluster. Unchecking it spares those tabs — they go back into
 * grouping — rather than filtering a plan whose group sizes would then be wrong.
 */
function DuplicateRow({
  cluster,
  keep,
  close,
  expanded,
  onSelect,
  onExpand,
}: {
  cluster: DuplicateCluster;
  keep: TabInfo | undefined;
  close: TabInfo[];
  expanded: boolean;
  onSelect: () => void;
  onExpand: () => void;
}) {
  const selected = !cluster.spare;
  const label = keep === undefined ? cluster.canonicalUrl : tabLabel(keep);
  const reason = `close ${plural(cluster.close.length, "copy", "copies")}`;

  return (
    <li className={selected ? "group" : "group group-off"}>
      <div className="group-head">
        <label className="group-main">
          <input type="checkbox" checked={selected} onChange={onSelect} />
          <span className="group-label">{label}</span>
          <span className="muted group-reason">{reason}</span>
        </label>

        <button
          type="button"
          className="chevron"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide copies of ${label}` : `Show copies of ${label}`}
          onClick={onExpand}
        >
          <Chevron expanded={expanded} />
        </button>
      </div>

      {expanded && (
        <ul className="tab-list">
          {keep !== undefined && (
            <li key={keep.id} title={keep.url}>
              Keep: {tabLabel(keep)}
            </li>
          )}
          {close.map((tab) => (
            <li key={tab.id} title={tab.url}>
              {tabLabel(tab)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [undoable, setUndoable] = useState<Snapshot | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [spared, setSpared] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [ungroupedOpen, setUngroupedOpen] = useState(false);
  const [collapseNewGroups, setCollapseNewGroups] = useState(true);

  useEffect(() => {
    let cancelled = false;

    if (!supportsTabGroups()) {
      setPhase({ status: "unsupported" });
      return;
    }

    readState()
      .then((loaded) => {
        if (cancelled) return;
        setUndoable(loaded.snapshot);
        setCollapseNewGroups(loaded.collapseNewGroups);
        setPhase({ status: "ready", windowId: loaded.windowId, tabs: loaded.tabs });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase({ status: "failed", message: describe(error) });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleApply(plan: GroupPlan): Promise<void> {
    setPhase({ status: "working", label: "Grouping tabs…" });
    await runApply(plan, [...excluded]);
  }

  async function handleCloseDuplicates(plan: GroupPlan): Promise<void> {
    setPhase({ status: "working", label: "Closing duplicates…" });
    await runApply(
      plan,
      plan.groups.map((group) => group.key),
    );
  }

  async function runApply(plan: GroupPlan, excludedKeys: readonly string[]): Promise<void> {
    try {
      const result = await applyPlan(plan, excludedKeys, { collapse: collapseNewGroups });
      const changed =
        result.snapshot.createdGroups.length > 0 || result.snapshot.closedTabs.length > 0;

      // An apply that changed nothing must not overwrite an older undo with an
      // empty one — the Undo button would then be a lie.
      if (changed) await saveSnapshot(result.snapshot);

      const failedLabels = result.failedKeys.map((key) => {
        const group = plan.groups.find((proposal) => proposal.key === key);
        return group === undefined ? key : group.label;
      });

      setUndoable(changed ? result.snapshot : undoable);
      setPhase({ status: "applied", result, failedLabels });
    } catch (error: unknown) {
      setPhase({ status: "failed", message: describe(error) });
    }
  }

  async function handleSort(by: "domain" | "title"): Promise<void> {
    if (phase.status !== "ready") return;
    setPhase({ status: "working", label: "Sorting tabs…" });

    try {
      await sortOrganisableTabs(phase.windowId, sortTabIds(phase.tabs, by));
      const loaded = await readState();
      setUndoable(loaded.snapshot);
      setCollapseNewGroups(loaded.collapseNewGroups);
      setPhase({ status: "ready", windowId: loaded.windowId, tabs: loaded.tabs });
    } catch (error: unknown) {
      setPhase({ status: "failed", message: describe(error) });
    }
  }

  async function handleUndo(snapshot: Snapshot): Promise<void> {
    setPhase({ status: "working", label: "Putting it back…" });

    try {
      await restore(snapshot);
      await clearSnapshot(snapshot.windowId);
      setUndoable(null);
      setExcluded(new Set());
      setSpared(new Set());

      // Back to a fresh preview rather than a "done" screen: the tabs just moved,
      // so anything still on screen would be describing a window that is gone.
      const loaded = await readState();
      setCollapseNewGroups(loaded.collapseNewGroups);
      setPhase({ status: "ready", windowId: loaded.windowId, tabs: loaded.tabs });
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

  async function handleCollapseChange(next: boolean): Promise<void> {
    setCollapseNewGroups(next);
    try {
      await saveUiSettings({ collapseNewGroups: next });
    } catch {
      // Preference did not stick; this apply still honours the checkbox.
    }
  }

  // The HTML #boot spinner covers this phase. Returning null keeps #root empty
  // so Firefox does not hide #boot and then sit on a blank popup.
  if (phase.status === "loading") return null;

  if (phase.status === "working") {
    return <Busy label={phase.label} />;
  }

  if (phase.status === "unsupported") {
    return (
      <p className="error">
        This build of Firefox has no tab groups API. Tab Organizer needs Firefox 139 or newer.
      </p>
    );
  }

  if (phase.status === "failed") {
    return (
      <>
        <p className="error">Something went wrong: {phase.message}</p>
        <div className="actions">
          {undoable !== null && (
            <button type="button" className="primary" onClick={() => void handleUndo(undoable)}>
              Undo last apply
            </button>
          )}
          <button type="button" onClick={() => window.close()}>
            Close
          </button>
        </div>
      </>
    );
  }

  if (phase.status === "applied") {
    const { snapshot } = phase.result;
    const nothingHappened = snapshot.createdGroups.length === 0 && snapshot.closedTabs.length === 0;

    return (
      <>
        <p className="done">
          {nothingHappened
            ? "Nothing changed."
            : snapshot.createdGroups.length === 0
              ? `Closed ${plural(snapshot.closedTabs.length, "duplicate", "duplicates")}.`
              : `Created ${plural(snapshot.createdGroups.length, "group", "groups")}` +
                (snapshot.closedTabs.length > 0
                  ? `, closed ${plural(snapshot.closedTabs.length, "duplicate", "duplicates")}.`
                  : ".")}
        </p>

        {phase.failedLabels.length > 0 && (
          <p className="error small">
            Could not create {phase.failedLabels.join(", ")}. Those tabs were left alone.
          </p>
        )}

        <div className="actions">
          {undoable !== null && (
            <button type="button" className="primary" onClick={() => void handleUndo(undoable)}>
              Undo
            </button>
          )}
          <button type="button" onClick={() => window.close()}>
            Close
          </button>
        </div>
      </>
    );
  }

  const config: Config = { ...DEFAULT_CONFIG, spareDuplicateCanonicals: [...spared] };
  const plan = buildPlan(phase.windowId, phase.tabs, config);

  const byId = new Map(phase.tabs.map((tab) => [tab.id, tab]));
  const selected = plan.groups.filter((group) => !excluded.has(group.key));
  const movingTabs = selected.reduce((total, group) => total + group.tabIds.length, 0);
  const closing = plan.stats.wouldClose;
  const nothingToDo = movingTabs === 0 && closing === 0;
  const hasGroups = plan.groups.length > 0;
  const hasDuplicates = plan.duplicates.length > 0;
  const hasUngrouped = plan.ungrouped.length > 0;
  const hasPlan = hasGroups || hasDuplicates;

  // The button says what it will do, so the summary above it does not have to be
  // read first. "Apply" is only meaningful to someone who already knows.
  const actionLabel =
    movingTabs > 0
      ? `Group ${plural(movingTabs, "tab", "tabs")}`
      : `Close ${plural(closing, "duplicate", "duplicates")}`;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleApply(plan);
      }}
    >
      {undoable !== null && (
        <div className="undo-bar">
          <span className="muted small">An earlier apply can still be undone.</span>
          <button type="button" className="link" onClick={() => void handleUndo(undoable)}>
            Undo
          </button>
        </div>
      )}

      {!hasPlan && (
        <p className="muted">
          Nothing worth grouping here. Every tab is either already in a group, pinned, or the only
          one of its kind.
        </p>
      )}

      {hasGroups && (
        <div className="summary">
          <span>
            <strong>{plan.stats.tabCount}</strong> loose tabs · <strong>{selected.length}</strong>{" "}
            of {plan.groups.length} groups
          </span>

          {plan.groups.length > 1 && (
            <PickAllNone
              onAll={() => setExcluded(new Set())}
              onNone={() => setExcluded(new Set(plan.groups.map((group) => group.key)))}
            />
          )}
        </div>
      )}

      {(hasPlan || hasUngrouped) && (
        <div className="plan-body">
          {hasGroups && (
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
          )}

          {hasDuplicates && (
            <section className="section">
              <div className="section-head">
                <span>Duplicates</span>
                {plan.duplicates.length > 1 && (
                  <PickAllNone
                    onAll={() => setSpared(new Set())}
                    onNone={() =>
                      setSpared(new Set(plan.duplicates.map((cluster) => cluster.canonicalUrl)))
                    }
                  />
                )}
              </div>
              <p className="muted small section-note">
                Undo reopens them, but their history and scroll position are lost.
              </p>
              <ul className="plan-list">
                {plan.duplicates.map((cluster) => (
                  <DuplicateRow
                    key={cluster.canonicalUrl}
                    cluster={cluster}
                    keep={byId.get(cluster.keep)}
                    close={lookup(byId, cluster.close)}
                    expanded={expanded.has(cluster.canonicalUrl)}
                    onSelect={() => toggle(spared, setSpared, cluster.canonicalUrl)}
                    onExpand={() => toggle(expanded, setExpanded, cluster.canonicalUrl)}
                  />
                ))}
              </ul>
            </section>
          )}

          {hasUngrouped && (
            <section className="section">
              <div className="group-head">
                <span className="muted small ungrouped-label">
                  {plural(plan.ungrouped.length, "tab stays", "tabs stay")} where they are.
                </span>
                <button
                  type="button"
                  className="chevron"
                  aria-expanded={ungroupedOpen}
                  aria-label={ungroupedOpen ? "Hide ungrouped tabs" : "Show ungrouped tabs"}
                  onClick={() => setUngroupedOpen(!ungroupedOpen)}
                >
                  <Chevron expanded={ungroupedOpen} />
                </button>
              </div>
              {ungroupedOpen && (
                <ul className="tab-list">
                  {lookup(byId, plan.ungrouped).map((tab) => (
                    <li key={tab.id} title={tab.url}>
                      {tabLabel(tab)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      {hasGroups && (
        <label className="setting">
          <input
            type="checkbox"
            checked={collapseNewGroups}
            onChange={(event) => void handleCollapseChange(event.target.checked)}
          />
          <span>Collapse new groups</span>
        </label>
      )}

      {phase.tabs.length > 0 && (
        <div className="tools">
          {closing > 0 && (
            <button type="button" onClick={() => void handleCloseDuplicates(plan)}>
              Close {plural(closing, "duplicate", "duplicates")} now
            </button>
          )}
          <button type="button" onClick={() => void handleSort("domain")}>
            Sort by domain
          </button>
          <button type="button" onClick={() => void handleSort("title")}>
            Sort by title
          </button>
        </div>
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={nothingToDo}>
          {nothingToDo ? "Nothing selected" : actionLabel}
        </button>
        <button type="button" onClick={() => window.close()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
