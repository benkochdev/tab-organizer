import { useEffect, useState } from "react";
import {
  type DomainRule,
  type DomainRuleAction,
  type GroupingMode,
  RULE_ACTIONS,
  saveUiSettings,
  type UiSettings,
} from "@/platform/settings";

function rulePlaceholder(action: DomainRuleAction): string {
  if (action === "always-name") return "Group name";
  if (action === "merge-into") return "Existing group";
  return "—";
}

function toRuleAction(value: string): DomainRuleAction {
  for (const action of RULE_ACTIONS) {
    if (action.value === value) return action.value;
  }
  return "always-name";
}

function newRule(): DomainRule {
  return { id: crypto.randomUUID(), pattern: "", action: "always-name", value: "" };
}

function readNumber(value: string, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function Options({ start }: { start: UiSettings }) {
  const [settings, setSettings] = useState(start);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  async function patch(next: Partial<UiSettings>): Promise<void> {
    setSettings((current) => ({ ...current, ...next }));
    try {
      await saveUiSettings(next);
    } catch {
      // Preference did not stick; the control still shows what the user chose.
    }
  }

  function updateRule(index: number, next: DomainRule): void {
    void patch({ rules: settings.rules.map((rule, i) => (i === index ? next : rule)) });
  }

  return (
    <div className="page">
      <header className="hero">
        <h1>Tab Organizer</h1>
        <p className="lede">
          Settings apply to the next plan you open. Nothing moves until you apply.
        </p>
      </header>

      <section className="block">
        <h2>Grouping</h2>
        <label className="choice">
          <input
            type="radio"
            name="grouping"
            checked={settings.groupingMode === "sites"}
            onChange={() => void patch({ groupingMode: "sites" satisfies GroupingMode })}
          />
          <span>
            <span>Sites</span>
            <span className="hint">
              Tabs from the same domain go together. Local, instant, predictable.
            </span>
          </span>
        </label>
        <label className="choice">
          <input
            type="radio"
            name="grouping"
            checked={settings.groupingMode === "topics"}
            onChange={() => void patch({ groupingMode: "topics" satisfies GroupingMode })}
          />
          <span>
            <span>Topics across sites</span>
            <span className="hint">
              Uses tab titles to group related tabs from different domains.
            </span>
            {settings.groupingMode === "topics" && (
              <span className="hint">Not in this build yet — the popup still groups by site.</span>
            )}
          </span>
        </label>
      </section>

      <section className="block">
        <h2>AI</h2>
        <label className="choice">
          <input
            type="checkbox"
            checked={settings.useAi}
            disabled={!online}
            onChange={(event) => void patch({ useAi: event.target.checked })}
          />
          <span>
            <span>Use AI to name and merge groups</span>
            <span className="hint">
              Runs only when you click the popup’s primary button, not when the popup opens. The
              preview you see stays the local plan. Tab titles and URLs are sent when it runs.
            </span>
          </span>
        </label>
        {!online && (
          <p className="callout">
            Unavailable while offline. The popup falls back to site grouping.
          </p>
        )}
        <label className="inline">
          <span className="hint">API key</span>
          <input type="text" placeholder="Not required yet" disabled />
        </label>
      </section>

      <section className="block">
        <h2>New groups</h2>
        <label className="choice">
          <input
            type="checkbox"
            checked={settings.collapseNewGroups}
            onChange={(event) => void patch({ collapseNewGroups: event.target.checked })}
          />
          <span>
            <span>Collapse new groups</span>
            <span className="hint">New groups appear closed in the tab strip.</span>
          </span>
        </label>
      </section>

      <section className="block">
        <h2>Thresholds</h2>
        <label className="field">
          <span className="field-label">Min group size</span>
          <input
            type="number"
            min={2}
            max={50}
            value={settings.minGroupSize}
            onChange={(event) => {
              const n = readNumber(event.target.value, 2, 50);
              if (n !== null) void patch({ minGroupSize: n });
            }}
          />
          <span className="hint">Fewer tabs than this stay where they are.</span>
        </label>
        <label className="field">
          <span className="field-label">Max groups</span>
          <input
            type="number"
            min={1}
            max={50}
            value={settings.maxGroups}
            onChange={(event) => {
              const n = readNumber(event.target.value, 1, 50);
              if (n !== null) void patch({ maxGroups: n });
            }}
          />
          <span className="hint">Per apply.</span>
        </label>
      </section>

      <section className="block">
        <h2>Duplicates</h2>
        <label className="choice">
          <input
            type="checkbox"
            checked={settings.detectDuplicates}
            onChange={(event) => void patch({ detectDuplicates: event.target.checked })}
          />
          <span>
            <span>Detect duplicates</span>
            <span className="hint">
              Shown as one line in the popup. Closed tabs lose their scroll position and back
              history — Undo reopens the page, not the history.
            </span>
          </span>
        </label>
      </section>

      <section className="block">
        <h2>Archive</h2>
        <label className="choice">
          <input
            type="checkbox"
            checked={settings.archiveEnabled}
            onChange={(event) => void patch({ archiveEnabled: event.target.checked })}
          />
          <span>
            <span>Collect old tabs into an Archive group</span>
            <span className="hint">
              Archive appears in the popup as a normal group row you can uncheck.
            </span>
            {settings.archiveEnabled && (
              <span className="hint">
                Not in this build yet — the popup will not show an Archive row.
              </span>
            )}
          </span>
        </label>
        <label className="inline indent">
          <span>Unused for</span>
          <input
            type="number"
            min={1}
            max={365}
            value={settings.archiveDays}
            disabled={!settings.archiveEnabled}
            onChange={(event) => {
              const n = readNumber(event.target.value, 1, 365);
              if (n !== null) void patch({ archiveDays: n });
            }}
          />
          <span>days</span>
        </label>
      </section>

      <section className="block last">
        <h2>Rules</h2>
        <p className="hint intro">Rules win over Sites and AI.</p>
        {settings.rules.length === 0 ? (
          <p className="hint">No extra rules. Sites are grouped by domain.</p>
        ) : (
          <div className="rules">
            <div className="rules-head">
              <span>Domain or pattern</span>
              <span>Action</span>
              <span>Value</span>
              <span />
            </div>
            {settings.rules.map((rule, index) => (
              <div className="rule" key={rule.id}>
                <input
                  type="text"
                  value={rule.pattern}
                  onChange={(event) => updateRule(index, { ...rule, pattern: event.target.value })}
                />
                <select
                  value={rule.action}
                  onChange={(event) => {
                    const action = toRuleAction(event.target.value);
                    updateRule(index, {
                      ...rule,
                      action,
                      value: action === "never-group" ? "" : rule.value,
                    });
                  }}
                >
                  {RULE_ACTIONS.map((action) => (
                    <option key={action.value} value={action.value}>
                      {action.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={rule.value}
                  placeholder={rulePlaceholder(rule.action)}
                  disabled={rule.action === "never-group"}
                  onChange={(event) => updateRule(index, { ...rule, value: event.target.value })}
                />
                <button
                  type="button"
                  className="icon"
                  title="Remove rule"
                  aria-label="Remove rule"
                  onClick={() =>
                    void patch({ rules: settings.rules.filter((_, i) => i !== index) })
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {settings.rules.length > 0 && (
          <p className="hint">Saved, but not applied yet — grouping still uses sites only.</p>
        )}
        <button
          type="button"
          className="quiet"
          onClick={() => void patch({ rules: [...settings.rules, newRule()] })}
        >
          Add rule
        </button>
      </section>
    </div>
  );
}
