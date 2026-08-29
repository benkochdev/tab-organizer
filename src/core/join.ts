import { winningRule } from "./rules";
import { compareStrings, googleProduct } from "./sites";
import type { Config, ExistingGroup, GroupProposal, TabInfo } from "./types";
import { hostnameOf, registrableDomain } from "./url";

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
}

type Fingerprint = {
  group: ExistingGroup;
  hosts: Set<string>;
  sites: Set<string>;
  products: Set<string>;
  /** Single Google product covering every google.com member, else null. */
  specializedProduct: string | null;
};

function fingerprint(group: ExistingGroup): Fingerprint {
  const hosts = new Set<string>();
  const sites = new Set<string>();
  const products = new Set<string>();
  let googleWithProduct = 0;
  let googleWithout = 0;

  for (const url of group.urls) {
    const host = hostnameOf(url);
    const site = registrableDomain(url);
    if (host !== null) hosts.add(host);
    if (site !== null) sites.add(site);
    const product = googleProduct(url);
    if (site === "google.com") {
      if (product === null) googleWithout += 1;
      else {
        products.add(product);
        googleWithProduct += 1;
      }
    } else if (product !== null) {
      products.add(product);
    }
  }

  const specializedProduct =
    googleWithout === 0 && googleWithProduct > 0 && products.size === 1
      ? ([...products][0] ?? null)
      : null;

  return { group, hosts, sites, products, specializedProduct };
}

/**
 * How tightly this tab belongs in the existing group. 0 means do not join.
 *
 * Host (same normalised host) beats Google product, which beats site (eTLD+1).
 * A Gmail-only group does not take Docs tabs via a shared google.com. never-group
 * tabs score 0. always-name / merge-into can join by matching the group title.
 */
function matchScore(tab: TabInfo, fp: Fingerprint, config: Config): number {
  const rule = winningRule(tab.url, config.rules);
  if (rule?.action === "never-group") return 0;

  const host = hostnameOf(tab.url);
  if (host !== null && fp.hosts.has(host)) return 3;

  const product = googleProduct(tab.url);
  if (product !== null && fp.products.has(product)) return 2;

  if (
    rule !== null &&
    (rule.action === "always-name" || rule.action === "merge-into") &&
    rule.value.trim() !== "" &&
    fp.group.title.trim() === rule.value.trim()
  ) {
    return 2;
  }

  const site = registrableDomain(tab.url);
  if (site === null || !fp.sites.has(site)) return 0;
  if (fp.specializedProduct !== null && product !== fp.specializedProduct) return 0;
  return 1;
}

type Assignment = { tab: TabInfo; group: ExistingGroup; score: number };

function pickGroup(
  tab: TabInfo,
  fingerprints: readonly Fingerprint[],
  config: Config,
): Assignment | null {
  let best: Assignment | null = null;

  for (const fp of fingerprints) {
    const score = matchScore(tab, fp, config);
    if (score === 0) continue;
    if (best === null) {
      best = { tab, group: fp.group, score };
      continue;
    }
    if (score > best.score) {
      best = { tab, group: fp.group, score };
      continue;
    }
    if (score < best.score) continue;
    if (fp.group.urls.length !== best.group.urls.length) {
      if (fp.group.urls.length > best.group.urls.length) {
        best = { tab, group: fp.group, score };
      }
      continue;
    }
    if (fp.group.id < best.group.id) best = { tab, group: fp.group, score };
  }

  return best;
}

function displayTitle(group: ExistingGroup): string {
  const title = group.title.trim();
  return title === "" ? "Untitled" : title;
}

/**
 * Assigns loose tabs to existing groups they already belong with.
 *
 * Guarantees: never regroups members of those groups; a single tab is enough;
 * never-group tabs are left alone; output is stable for equivalent input;
 * join proposals do not consume maxGroups.
 */
export function joinExistingGroups(
  tabs: TabInfo[],
  existing: readonly ExistingGroup[],
  config: Config,
): { groups: GroupProposal[]; remaining: TabInfo[] } {
  if (existing.length === 0) {
    return { groups: [], remaining: [...tabs] };
  }

  const fingerprints = existing.filter((group) => group.urls.length > 0).map(fingerprint);
  const remaining: TabInfo[] = [];
  const buckets = new Map<number, { group: ExistingGroup; tabs: TabInfo[] }>();

  for (const tab of tabs) {
    const picked = pickGroup(tab, fingerprints, config);
    if (picked === null) {
      remaining.push(tab);
      continue;
    }
    const bucket = buckets.get(picked.group.id);
    if (bucket === undefined) buckets.set(picked.group.id, { group: picked.group, tabs: [tab] });
    else bucket.tabs.push(tab);
  }

  const groups: GroupProposal[] = [...buckets.values()].map(({ group, tabs: members }) => {
    const ordered = [...members].sort(byTabIndex);
    const n = ordered.length;
    const label = displayTitle(group);
    return {
      key: `existing:${group.id}`,
      label,
      color: group.color,
      tabIds: ordered.map((tab) => tab.id),
      reason: `add ${n} ${n === 1 ? "tab" : "tabs"} to ${label}`,
      existingGroupId: group.id,
    };
  });

  groups.sort((a, b) => b.tabIds.length - a.tabIds.length || compareStrings(a.key, b.key));
  remaining.sort(byTabIndex);

  return { groups, remaining };
}
