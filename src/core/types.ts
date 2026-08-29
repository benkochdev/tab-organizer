/**
 * The data the core reasons about. Plain values only — nothing in here knows
 * that a browser exists.
 */

/**
 * The nine colours the tabGroups API accepts, written out by hand so that
 * src/core/ stays free of browser types. `toBrowserColor` in
 * src/platform/apply.ts is a compile-time check that this union stays a subset
 * of what the browser will actually accept.
 */
export type GroupColor =
  | "blue"
  | "cyan"
  | "green"
  | "grey"
  | "orange"
  | "pink"
  | "purple"
  | "red"
  | "yellow";

/**
 * One tab, as the core sees it.
 *
 * Note what is absent: `pinned` and `groupId`. Pinned tabs, privileged URLs and
 * tabs that are already in a group are filtered out by the adapter and never
 * reach the core, so carrying fields the core must remember to ignore would only
 * invite bugs.
 */
export type TabInfo = {
  id: number;
  windowId: number;
  /** Position in the tab strip. The tie-breaker that makes output stable. */
  index: number;
  url: string;
  title: string;
  /** Epoch ms, passed in — the core never calls Date.now(). */
  lastAccessed: number;
};

export type GroupProposal = {
  /** Stable across runs, e.g. "domain:github.com". */
  key: string;
  label: string;
  color: GroupColor;
  tabIds: number[];
  /** Shown in the preview. A grouping you cannot explain is one nobody trusts. */
  reason: string;
  /**
   * When set, apply adds these tabs to this existing Firefox group instead of
   * creating a new one. Omitted for groups we would create.
   */
  existingGroupId?: number;
};

/**
 * A group that already exists in the window. Member tabs never reach the core
 * as TabInfo (D-005); these fingerprints are how loose tabs join them (D-034).
 */
export type ExistingGroup = {
  id: number;
  title: string;
  color: GroupColor;
  /** http(s) URLs of unpinned members, used only to decide who belongs. */
  urls: string[];
};

export type DuplicateCluster = {
  canonicalUrl: string;
  /** The tab we keep: the leftmost one in the tab strip. */
  keep: number;
  close: number[];
  /**
   * When true, those `close` tabs stay in the window and participate in grouping.
   * The cluster is still listed so the preview can show it unchecked.
   */
  spare: boolean;
};

export type GroupPlan = {
  windowId: number;
  groups: GroupProposal[];
  /** Tabs that stay where they are. */
  ungrouped: number[];
  duplicates: DuplicateCluster[];
  stats: { tabCount: number; groupCount: number; wouldClose: number };
};

export type DomainRuleAction = "always-name" | "never-group" | "merge-into";

/**
 * A user override of default domain grouping. `id` is UI-only and unused here.
 * Empty patterns, and empty values on always-name / merge-into, are skipped by
 * the rules stage — never-group ignores `value`.
 */
export type DomainRule = {
  pattern: string;
  action: DomainRuleAction;
  value: string;
};

export type Config = {
  /** Below this, a domain is not a group. Two tabs is not clutter. */
  minGroupSize: number;
  /** Upper bound on proposals, so a chaotic window does not produce forty groups. */
  maxGroups: number;
  detectDuplicates: boolean;
  /** Canonical URLs whose duplicate clusters are listed but not closed. */
  spareDuplicateCanonicals: string[];
  /** Host/site overrides applied after duplicates and before domain clustering. */
  rules: DomainRule[];
};

export const DEFAULT_CONFIG: Config = {
  minGroupSize: 3,
  maxGroups: 12,
  detectDuplicates: true,
  spareDuplicateCanonicals: [],
  rules: [],
};
