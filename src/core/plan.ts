import type {
  Config,
  DuplicateCluster,
  GroupColor,
  GroupPlan,
  GroupProposal,
  TabInfo,
} from "./types";
import { canonicalUrl, registrableDomain } from "./url";

/**
 * The whole product, as one pure function.
 *
 * The ordering rules in here exist for one reason: a preview the user is asked
 * to approve must not reshuffle between runs. Every sort is total and every
 * comparison is on code units rather than locale, so the same tabs always
 * produce byte-identical output.
 */

/** Deterministic, locale-independent. `localeCompare` is neither. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
}

const PALETTE: readonly GroupColor[] = [
  "blue",
  "cyan",
  "green",
  "grey",
  "orange",
  "pink",
  "purple",
  "red",
  "yellow",
];

/**
 * Same key, same colour, forever — the colour is a property of the domain, not
 * of where it happened to land in this run's sort order.
 */
function colorForKey(key: string): GroupColor {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) >>> 0;
  }
  // The index is always in range; the ?? is how we satisfy
  // noUncheckedIndexedAccess without reaching for a non-null assertion.
  return PALETTE[hash % PALETTE.length] ?? "blue";
}

/**
 * "github.com" -> "Github", "bbc.co.uk" -> "Bbc".
 * Crude, and knowingly ugly for hosts like "t.co". A known-services table
 * replaces this later; until then a wrong-looking label is a cosmetic problem,
 * not a correctness one.
 */
function labelForDomain(domain: string): string {
  const head = domain.split(".")[0] ?? domain;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/**
 * Groups tabs that render the same page and picks one survivor each.
 *
 * The closed tabs are removed from what the grouping stages see, so a group in
 * the preview always lists exactly the tabs that will exist after apply. A
 * preview whose groups shrink when you click it is a preview nobody trusts.
 */
function findDuplicates(tabs: TabInfo[]): DuplicateCluster[] {
  const byCanonical = new Map<string, TabInfo[]>();

  for (const tab of tabs) {
    const canonical = canonicalUrl(tab.url);
    // No canonical form (about:, file:, junk) means we cannot claim two tabs are
    // the same page, so we never propose closing them.
    if (canonical === null) continue;

    const bucket = byCanonical.get(canonical);
    if (bucket) bucket.push(tab);
    else byCanonical.set(canonical, [tab]);
  }

  const duplicates: DuplicateCluster[] = [];

  for (const [canonical, bucket] of byCanonical) {
    if (bucket.length < 2) continue;

    const [keep, ...rest] = [...bucket].sort(byTabIndex);
    // bucket.length >= 2 guarantees keep exists; this is the type-level proof.
    if (keep === undefined) continue;

    duplicates.push({
      canonicalUrl: canonical,
      keep: keep.id,
      close: rest.map((tab) => tab.id),
      spare: false,
    });
  }

  duplicates.sort((a, b) => compareStrings(a.canonicalUrl, b.canonicalUrl));

  return duplicates;
}

/**
 * Buckets tabs by registrable domain and promotes the big buckets to groups.
 *
 * Returns groups sorted by size descending, ties broken by domain ascending, and
 * every tab that did not make it — because its domain was too small, because
 * there were more qualifying domains than maxGroups, or because it has no
 * registrable domain at all.
 */
function clusterByDomain(
  tabs: TabInfo[],
  config: Config,
): { groups: GroupProposal[]; remaining: TabInfo[] } {
  const byDomain = new Map<string, TabInfo[]>();
  const remaining: TabInfo[] = [];

  for (const tab of tabs) {
    const domain = registrableDomain(tab.url);
    if (domain === null) {
      remaining.push(tab);
      continue;
    }

    const bucket = byDomain.get(domain);
    if (bucket) bucket.push(tab);
    else byDomain.set(domain, [tab]);
  }

  const qualifying: [string, TabInfo[]][] = [];

  for (const entry of byDomain) {
    if (entry[1].length >= config.minGroupSize) qualifying.push(entry);
    else remaining.push(...entry[1]);
  }

  qualifying.sort(
    ([domainA, tabsA], [domainB, tabsB]) =>
      tabsB.length - tabsA.length || compareStrings(domainA, domainB),
  );

  const cap = Math.max(0, config.maxGroups);
  for (const [, overflow] of qualifying.slice(cap)) remaining.push(...overflow);

  const groups = qualifying.slice(0, cap).map(([domain, bucket]): GroupProposal => {
    const ordered = [...bucket].sort(byTabIndex);
    const key = `domain:${domain}`;

    return {
      key,
      label: labelForDomain(domain),
      color: colorForKey(key),
      tabIds: ordered.map((tab) => tab.id),
      reason: `${ordered.length} ${ordered.length === 1 ? "tab" : "tabs"} from ${domain}`,
    };
  });

  remaining.sort(byTabIndex);

  return { groups, remaining };
}

/**
 * Turns the tabs of one window into a plan the user can read and approve.
 *
 * Guarantees: pure, total, and stable — equivalent input always yields
 * byte-identical output. Never mutates `tabs`. Proposes, never performs.
 * Duplicate clusters are always listed when detected; `spare` clusters keep
 * their close-tabs in grouping and do not count toward `wouldClose`.
 */
export function buildPlan(windowId: number, tabs: TabInfo[], config: Config): GroupPlan {
  const found = config.detectDuplicates ? findDuplicates(tabs) : [];

  const spare = new Set(config.spareDuplicateCanonicals);
  const duplicates = found.map((cluster) => ({
    ...cluster,
    spare: spare.has(cluster.canonicalUrl),
  }));

  // Spared close-tabs go back into grouping. Remaining is computed from the
  // spare flags rather than from detection alone, so the groups match apply.
  const closing = new Set(
    duplicates.filter((cluster) => !cluster.spare).flatMap((cluster) => cluster.close),
  );
  const survivors = tabs.filter((tab) => !closing.has(tab.id));

  const { groups, remaining: ungrouped } = clusterByDomain(survivors, config);

  return {
    windowId,
    groups,
    ungrouped: ungrouped.map((tab) => tab.id),
    duplicates,
    stats: {
      tabCount: tabs.length,
      groupCount: groups.length,
      wouldClose: duplicates
        .filter((cluster) => !cluster.spare)
        .reduce((total, cluster) => total + cluster.close.length, 0),
    },
  };
}
