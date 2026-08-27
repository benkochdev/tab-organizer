import { compareStrings } from "./sites";
import type { TabInfo } from "./types";
import { registrableDomain } from "./url";

export type TabSort = "domain" | "title";

/**
 * Order to move loose tabs into.
 *
 * Guarantees a total, stable order: domain uses eTLD+1 then URL; title uses the
 * title as code units (case-folded). Ties break on tab index.
 */
export function sortTabIds(tabs: readonly TabInfo[], by: TabSort): number[] {
  const copy = [...tabs];

  copy.sort((a, b) => {
    if (by === "title") {
      return compareStrings(a.title.toLowerCase(), b.title.toLowerCase()) || a.index - b.index;
    }

    const domainA = registrableDomain(a.url) ?? a.url;
    const domainB = registrableDomain(b.url) ?? b.url;
    return compareStrings(domainA, domainB) || compareStrings(a.url, b.url) || a.index - b.index;
  });

  return copy.map((tab) => tab.id);
}
