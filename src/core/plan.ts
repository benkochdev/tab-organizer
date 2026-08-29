import { peelArchive } from "./archive";
import { joinExistingGroups } from "./join";
import { applyDomainRules } from "./rules";
import { compareStrings, splitMixedSite } from "./sites";
import { clusterByTopic } from "./topics";
import type {
  Config,
  DuplicateCluster,
  ExistingGroup,
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

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
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
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const splitGroups: GroupProposal[] = [];

  for (const [domain, bucket] of qualifying.slice(0, cap)) {
    const split = splitMixedSite(domain, bucket, config);
    splitGroups.push(...split.groups);
    remaining.push(...split.leftover);
  }

  for (const [, overflow] of qualifying.slice(cap)) remaining.push(...overflow);

  splitGroups.sort((a, b) => b.tabIds.length - a.tabIds.length || compareStrings(a.key, b.key));

  const groups = splitGroups.slice(0, cap);
  for (const overflow of splitGroups.slice(cap)) {
    for (const id of overflow.tabIds) {
      const tab = byId.get(id);
      if (tab !== undefined) remaining.push(tab);
    }
  }

  remaining.sort(byTabIndex);

  return { groups, remaining };
}

/**
 * Turns the tabs of one window into a plan the user can read and approve.
 *
 * Guarantees: pure, total, and stable — equivalent input always yields
 * byte-identical output. Never mutates `tabs`. Proposes, never performs.
 * Duplicate clusters are always listed when detected; `spare` clusters keep
 * their close-tabs in grouping and do not count toward `wouldClose`. Loose tabs
 * join existing groups before rules and site clustering (D-034); those join
 * proposals do not consume maxGroups. Domain rules then fill maxGroups first
 * (size desc, key asc) and may be smaller than minGroupSize. Topics, when
 * enabled, cluster only the remainder after site grouping. Archive peels idle
 * tabs after duplicates and before join (time is `now`, never Date.now()).
 */
export function buildPlan(
  windowId: number,
  tabs: TabInfo[],
  config: Config,
  existingGroups: readonly ExistingGroup[] = [],
  now = 0,
): GroupPlan {
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

  const { groups: archiveGroups, remaining: afterArchive } = peelArchive(
    survivors,
    config,
    existingGroups,
    now,
  );

  const { groups: joinGroups, remaining: afterJoin } = joinExistingGroups(
    afterArchive,
    existingGroups,
    config,
  );

  const afterArchiveCap = Math.max(0, config.maxGroups - archiveGroups.length);
  const {
    groups: ruleGroups,
    remaining: afterRules,
    neverGrouped,
  } = applyDomainRules(afterJoin, { ...config, maxGroups: afterArchiveCap });

  const remainingSlots = Math.max(0, afterArchiveCap - ruleGroups.length);
  const { groups: domainGroups, remaining: leftover } = clusterByDomain(afterRules, {
    ...config,
    maxGroups: remainingSlots,
  });

  const topicSlots = Math.max(0, remainingSlots - domainGroups.length);
  const { groups: topicGroups, remaining: afterTopics } =
    config.groupingMode === "topics"
      ? clusterByTopic(leftover, { ...config, maxGroups: topicSlots })
      : { groups: [], remaining: leftover };

  const groups = [
    ...archiveGroups,
    ...joinGroups,
    ...ruleGroups,
    ...domainGroups,
    ...topicGroups,
  ].sort((a, b) => b.tabIds.length - a.tabIds.length || compareStrings(a.key, b.key));

  const ungrouped = [...neverGrouped, ...afterTopics].sort(byTabIndex);

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
