import { colorForKey, compareStrings, titleTokens } from "./sites";
import type { Config, GroupProposal, TabInfo } from "./types";

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function firstToken(title: string): string | null {
  return titleTokens(title)[0] ?? null;
}

function firstTokenHits(token: string, members: readonly TabInfo[]): number {
  let n = 0;
  for (const tab of members) {
    if (firstToken(tab.title) === token) n += 1;
  }
  return n;
}

function betterToken(
  token: string,
  members: TabInfo[],
  bestToken: string | null,
  bestMembers: TabInfo[],
): boolean {
  if (members.length > bestMembers.length) return true;
  if (members.length < bestMembers.length) return false;
  if (bestToken === null) return true;
  const hits = firstTokenHits(token, members);
  const bestHits = firstTokenHits(bestToken, bestMembers);
  if (hits !== bestHits) return hits > bestHits;
  return compareStrings(token, bestToken) < 0;
}

/**
 * Clusters leftover tabs by shared title tokens, across sites.
 *
 * Guarantees: never peels a group below minGroupSize; a token covering the
 * whole remainder is still a topic (unlike in-site Wikipedia splits); output is
 * stable for equivalent input; groups are capped at maxGroups (size desc, key
 * asc) with overflow returned as remaining.
 */
export function clusterByTopic(
  tabs: TabInfo[],
  config: Config,
): { groups: GroupProposal[]; remaining: TabInfo[] } {
  let leftover = [...tabs];
  const peeled: GroupProposal[] = [];

  while (leftover.length >= config.minGroupSize) {
    const tokenTabs = new Map<string, TabInfo[]>();

    for (const tab of leftover) {
      for (const token of titleTokens(tab.title)) {
        const bucket = tokenTabs.get(token);
        if (bucket) bucket.push(tab);
        else tokenTabs.set(token, [tab]);
      }
    }

    let bestToken: string | null = null;
    let bestMembers: TabInfo[] = [];

    for (const [token, members] of tokenTabs) {
      if (members.length < config.minGroupSize) continue;
      if (betterToken(token, members, bestToken, bestMembers)) {
        bestToken = token;
        bestMembers = members;
      }
    }

    if (bestToken === null) break;

    const taken = new Set(bestMembers.map((tab) => tab.id));
    const members = [...bestMembers].sort(byTabIndex);
    const n = members.length;
    peeled.push({
      key: `topic:${bestToken}`,
      label: capitalise(bestToken),
      color: colorForKey(`topic:${bestToken}`),
      tabIds: members.map((tab) => tab.id),
      reason: `${n} ${n === 1 ? "tab" : "tabs"} about ${bestToken}`,
    });
    leftover = leftover.filter((tab) => !taken.has(tab.id));
  }

  peeled.sort((a, b) => b.tabIds.length - a.tabIds.length || compareStrings(a.key, b.key));

  const cap = Math.max(0, config.maxGroups);
  const kept = peeled.slice(0, cap);
  const keptIds = new Set(kept.flatMap((group) => group.tabIds));
  const remaining = tabs.filter((tab) => !keptIds.has(tab.id)).sort(byTabIndex);

  return { groups: kept, remaining };
}
