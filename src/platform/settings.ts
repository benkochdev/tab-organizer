import { browser } from "wxt/browser";
import { DEFAULT_CONFIG } from "@/core/types";

/**
 * Preferences that outlive a session. Collapse, thresholds, and the rest of the
 * options page live in `storage.local` rather than `storage.session` because they
 * are not per-window facts.
 *
 * Settings the plan pipeline does not read yet (topics, archive, rules, AI) are
 * still persisted here so the options page is the source of truth when those
 * stages land. Loading never throws: missing or malformed storage is defaults.
 */

const SETTINGS_KEY = "ui.settings";

export type GroupingMode = "sites" | "topics";

export type DomainRuleAction = "always-name" | "never-group" | "merge-into";

export type DomainRule = {
  id: string;
  pattern: string;
  action: DomainRuleAction;
  value: string;
};

export type UiSettings = {
  collapseNewGroups: boolean;
  makeTabGroups: boolean;
  groupingMode: GroupingMode;
  useAi: boolean;
  minGroupSize: number;
  maxGroups: number;
  detectDuplicates: boolean;
  archiveEnabled: boolean;
  archiveDays: number;
  rules: DomainRule[];
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  collapseNewGroups: true,
  makeTabGroups: true,
  groupingMode: "sites",
  useAi: false,
  minGroupSize: DEFAULT_CONFIG.minGroupSize,
  maxGroups: DEFAULT_CONFIG.maxGroups,
  detectDuplicates: DEFAULT_CONFIG.detectDuplicates,
  archiveEnabled: false,
  archiveDays: 14,
  rules: [],
};

export const RULE_ACTIONS: { value: DomainRuleAction; label: string }[] = [
  { value: "always-name", label: "Name group" },
  { value: "never-group", label: "Do not group" },
  { value: "merge-into", label: "Merge into" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isGroupingMode(value: unknown): value is GroupingMode {
  return value === "sites" || value === "topics";
}

function isRuleAction(value: unknown): value is DomainRuleAction {
  return value === "always-name" || value === "never-group" || value === "merge-into";
}

function newRuleId(): string {
  return crypto.randomUUID();
}

function parseRules(value: unknown): DomainRule[] {
  if (!Array.isArray(value)) return DEFAULT_UI_SETTINGS.rules;

  const rules: DomainRule[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.pattern !== "string" || !isRuleAction(item.action)) continue;
    if (typeof item.value !== "string") continue;
    const id = typeof item.id === "string" && item.id !== "" ? item.id : newRuleId();
    rules.push({ id, pattern: item.pattern, action: item.action, value: item.value });
  }
  return rules;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Missing or malformed storage is treated as the defaults. */
export async function loadUiSettings(): Promise<UiSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const value: unknown = stored[SETTINGS_KEY];

  if (!isRecord(value)) return DEFAULT_UI_SETTINGS;

  return {
    collapseNewGroups: parseBoolean(value.collapseNewGroups, DEFAULT_UI_SETTINGS.collapseNewGroups),
    makeTabGroups: parseBoolean(value.makeTabGroups, DEFAULT_UI_SETTINGS.makeTabGroups),
    groupingMode: isGroupingMode(value.groupingMode)
      ? value.groupingMode
      : DEFAULT_UI_SETTINGS.groupingMode,
    useAi: parseBoolean(value.useAi, DEFAULT_UI_SETTINGS.useAi),
    minGroupSize: clampInt(value.minGroupSize, 2, 50, DEFAULT_UI_SETTINGS.minGroupSize),
    maxGroups: clampInt(value.maxGroups, 1, 50, DEFAULT_UI_SETTINGS.maxGroups),
    detectDuplicates: parseBoolean(value.detectDuplicates, DEFAULT_UI_SETTINGS.detectDuplicates),
    archiveEnabled: parseBoolean(value.archiveEnabled, DEFAULT_UI_SETTINGS.archiveEnabled),
    archiveDays: clampInt(value.archiveDays, 1, 365, DEFAULT_UI_SETTINGS.archiveDays),
    rules: parseRules(value.rules),
  };
}

/** Merges `patch` onto whatever is stored so a single control cannot wipe the rest. */
export async function saveUiSettings(patch: Partial<UiSettings>): Promise<void> {
  const current = await loadUiSettings();
  await browser.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

/** Opens the options page. Firefox closes the popup when focus moves. */
export async function openOptionsPage(): Promise<void> {
  await browser.runtime.openOptionsPage();
}
