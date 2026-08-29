import { winningRule } from "./rules";
import { colorForKey } from "./sites";
import type { Config, ExistingGroup, GroupProposal, TabInfo } from "./types";

export const ARCHIVE_LABEL = "Archive";
export const MS_PER_DAY = 86_400_000;

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
}

function isIdle(tab: TabInfo, now: number, days: number): boolean {
  return now - tab.lastAccessed >= days * MS_PER_DAY;
}

function existingArchive(groups: readonly ExistingGroup[]): ExistingGroup | null {
  const matches = groups.filter((group) => group.title.trim() === ARCHIVE_LABEL);
  matches.sort((a, b) => b.urls.length - a.urls.length || a.id - b.id);
  return matches[0] ?? null;
}

/**
 * Pulls idle tabs into one Archive group before site clustering.
 *
 * Guarantees: never-group tabs are left alone; a single idle tab is enough;
 * lastAccessed 0 counts as idle once `now` is past the threshold; if a group
 * titled Archive already exists, the proposal joins it instead of creating
 * another. Output is stable for equivalent input.
 */
export function peelArchive(
  tabs: TabInfo[],
  config: Config,
  existingGroups: readonly ExistingGroup[],
  now: number,
): { groups: GroupProposal[]; remaining: TabInfo[] } {
  if (!config.archiveEnabled || config.archiveDays < 1) {
    return { groups: [], remaining: [...tabs] };
  }

  const idle: TabInfo[] = [];
  const remaining: TabInfo[] = [];

  for (const tab of tabs) {
    const rule = winningRule(tab.url, config.rules);
    if (rule?.action === "never-group" || !isIdle(tab, now, config.archiveDays)) {
      remaining.push(tab);
      continue;
    }
    idle.push(tab);
  }

  if (idle.length === 0) {
    remaining.sort(byTabIndex);
    return { groups: [], remaining };
  }

  const members = [...idle].sort(byTabIndex);
  const n = members.length;
  const days = config.archiveDays;
  const existing = existingArchive(existingGroups);
  const group: GroupProposal = {
    key: "archive",
    label: ARCHIVE_LABEL,
    color: colorForKey("archive"),
    tabIds: members.map((tab) => tab.id),
    reason: `${n} ${n === 1 ? "tab" : "tabs"} unused for ${days} ${days === 1 ? "day" : "days"}`,
  };
  if (existing !== null) {
    group.existingGroupId = existing.id;
    group.color = existing.color;
    const title = existing.title.trim();
    if (title !== "") group.label = title;
  }

  remaining.sort(byTabIndex);

  return { groups: [group], remaining };
}
