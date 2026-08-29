import { colorForKey, compareStrings } from "./sites";
import type { Config, DomainRule, GroupProposal, TabInfo } from "./types";
import { hostnameOf, hostnameOfPattern, registrableDomain } from "./url";

export type RuleMatchKind = "host" | "site";

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
}

function isUsableRule(rule: DomainRule): boolean {
  if (hostnameOfPattern(rule.pattern) === null) return false;
  if (rule.action === "never-group") return true;
  return rule.value.trim() !== "";
}

/**
 * Whether `pattern` applies to this tab URL, and how tightly.
 *
 * Guarantees: host match when the normalised pattern equals the tab host; site
 * match when it equals the registrable domain and did not already host-match;
 * null when the pattern is empty or does not match. Never glob or substring.
 */
export function matchDomainRule(pattern: string, url: string): RuleMatchKind | null {
  const needle = hostnameOfPattern(pattern);
  if (needle === null) return null;
  const host = hostnameOf(url);
  if (host === null) return null;
  if (host === needle) return "host";
  const site = registrableDomain(url);
  if (site === needle) return "site";
  return null;
}

/**
 * First host match in list order, else first site match. Host beats site when
 * both a host rule and a site rule could apply. Skipped rules do not win.
 *
 * Guarantees a never-group rule wins over later name/merge rules on the same
 * tab, and that unusable rules (empty pattern / empty value) never win.
 */
export function winningRule(url: string, rules: readonly DomainRule[]): DomainRule | null {
  let siteWinner: DomainRule | null = null;
  for (const rule of rules) {
    if (!isUsableRule(rule)) continue;
    const kind = matchDomainRule(rule.pattern, url);
    if (kind === "host") return rule;
    if (kind === "site" && siteWinner === null) siteWinner = rule;
  }
  return siteWinner;
}

type Bucket = {
  label: string;
  tabs: TabInfo[];
  patterns: string[];
  named: boolean;
  merged: boolean;
};

function patternForReason(rule: DomainRule): string {
  return hostnameOfPattern(rule.pattern) ?? rule.pattern.trim();
}

function addToBucket(buckets: Map<string, Bucket>, rule: DomainRule, tab: TabInfo): void {
  const label = rule.value.trim();
  const pattern = patternForReason(rule);
  const bucket = buckets.get(label);
  if (bucket === undefined) {
    buckets.set(label, {
      label,
      tabs: [tab],
      patterns: [pattern],
      named: rule.action === "always-name",
      merged: rule.action === "merge-into",
    });
    return;
  }
  bucket.tabs.push(tab);
  if (!bucket.patterns.includes(pattern)) bucket.patterns.push(pattern);
  if (rule.action === "always-name") bucket.named = true;
  if (rule.action === "merge-into") bucket.merged = true;
}

function siteOf(tab: TabInfo): string | null {
  return registrableDomain(tab.url);
}

/**
 * Merge of two hosts on the same site is a no-op: those tabs go back to domain
 * clustering. A merge that peels one host off a site, or joins two sites, stays.
 */
function otherTabsOnSite(
  site: string,
  label: string,
  buckets: Map<string, Bucket>,
  remaining: TabInfo[],
): boolean {
  if (remaining.some((tab) => siteOf(tab) === site)) return true;
  for (const [otherLabel, other] of buckets) {
    if (otherLabel === label) continue;
    if (other.tabs.some((tab) => siteOf(tab) === site)) return true;
  }
  return false;
}

function restoreSameSiteMerges(buckets: Map<string, Bucket>, remaining: TabInfo[]): void {
  for (const [label, bucket] of [...buckets]) {
    if (bucket.named || !bucket.merged) continue;
    const sites = new Set<string>();
    let allHaveSite = true;
    for (const tab of bucket.tabs) {
      const site = siteOf(tab);
      if (site === null) {
        allHaveSite = false;
        break;
      }
      sites.add(site);
    }
    if (!allHaveSite || sites.size !== 1) continue;
    const site = [...sites][0];
    if (site === undefined) continue;
    if (otherTabsOnSite(site, label, buckets, remaining)) continue;
    remaining.push(...bucket.tabs);
    buckets.delete(label);
  }
}

function proposalFromBucket(bucket: Bucket): GroupProposal {
  const members = [...bucket.tabs].sort(byTabIndex);
  const patterns = [...bucket.patterns].sort(compareStrings);
  const key = `rule:${bucket.label}`;
  const listed = patterns.join(", ");
  const n = members.length;
  const count = `${n} ${n === 1 ? "tab" : "tabs"}`;
  const reason = bucket.named
    ? `${count} named ${bucket.label} by rule ${listed}`
    : `${count} merged by rule ${listed}`;
  return {
    key,
    label: bucket.label,
    color: colorForKey(key),
    tabIds: members.map((tab) => tab.id),
    reason,
  };
}

/**
 * Pulls matching tabs out of domain clustering.
 *
 * Guarantees: never-group tabs are not clustered; named/merged groups share a
 * key `rule:<value>` for the same trimmed value; groups may be smaller than
 * minGroupSize; same-site host merges that cover the whole site are a no-op;
 * output is stable for equivalent input.
 */
export function applyDomainRules(
  tabs: TabInfo[],
  config: Config,
): { groups: GroupProposal[]; remaining: TabInfo[]; neverGrouped: TabInfo[] } {
  const neverGrouped: TabInfo[] = [];
  const remaining: TabInfo[] = [];
  const buckets = new Map<string, Bucket>();

  for (const tab of tabs) {
    const rule = winningRule(tab.url, config.rules);
    if (rule === null) {
      remaining.push(tab);
      continue;
    }
    if (rule.action === "never-group") {
      neverGrouped.push(tab);
      continue;
    }
    addToBucket(buckets, rule, tab);
  }

  restoreSameSiteMerges(buckets, remaining);

  const ranked = [...buckets.values()].sort(
    (a, b) => b.tabs.length - a.tabs.length || compareStrings(`rule:${a.label}`, `rule:${b.label}`),
  );

  const cap = Math.max(0, config.maxGroups);
  const kept = ranked.slice(0, cap);
  for (const overflow of ranked.slice(cap)) remaining.push(...overflow.tabs);

  remaining.sort(byTabIndex);
  neverGrouped.sort(byTabIndex);

  return {
    groups: kept.map(proposalFromBucket),
    remaining,
    neverGrouped,
  };
}
