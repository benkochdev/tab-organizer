import { describe, expect, it } from "vitest";
import { buildPlan } from "./plan";
import { type Config, DEFAULT_CONFIG, type TabInfo } from "./types";

const WINDOW = 1;

/** Builds a tab with sane defaults so each test only states what it cares about. */
function tab(id: number, url: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: WINDOW,
    index: id,
    url,
    title: `Tab ${id}`,
    lastAccessed: 0,
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** n tabs on one domain, ids starting at `from`. */
function tabsOn(domain: string, count: number, from = 1): TabInfo[] {
  return Array.from({ length: count }, (_, i) => tab(from + i, `https://${domain}/page${i}`));
}

describe("buildPlan — domain clustering", () => {
  it("handles an empty window without inventing anything", () => {
    const plan = buildPlan(WINDOW, [], config());

    expect(plan.windowId).toBe(WINDOW);
    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.stats).toEqual({ tabCount: 0, groupCount: 0, wouldClose: 0 });
  });

  it("groups a domain once it reaches minGroupSize", () => {
    const plan = buildPlan(WINDOW, tabsOn("github.com", 3), config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:github.com");
    expect(plan.groups[0]?.label).toBe("Github");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(plan.ungrouped).toEqual([]);
  });

  it("leaves a domain alone one tab below minGroupSize", () => {
    const plan = buildPlan(WINDOW, tabsOn("github.com", 2), config({ minGroupSize: 3 }));

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2]);
  });

  it("puts every tab in ungrouped when no domain qualifies", () => {
    const tabs = [tab(1, "https://a.com/x"), tab(2, "https://b.com/x"), tab(3, "https://c.com/x")];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2, 3]);
  });

  it("merges subdomains into their registrable domain", () => {
    // Pinned behaviour: mail. and docs. are one Google group, not two.
    const tabs = [
      tab(1, "https://mail.google.com/inbox"),
      tab(2, "https://docs.google.com/doc/1"),
      tab(3, "https://drive.google.com/file/2"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:google.com");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
  });

  it("keeps GitHub Pages sites apart, because github.io is a public suffix", () => {
    const tabs = [...tabsOn("ben.github.io", 3, 1), ...tabsOn("someone-else.github.io", 3, 10)];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups.map((group) => group.key).sort()).toEqual([
      "domain:ben.github.io",
      "domain:someone-else.github.io",
    ]);
  });

  it("sends tabs without a registrable domain to ungrouped", () => {
    const tabs = [
      ...tabsOn("github.com", 3, 1),
      tab(10, "http://localhost:3000/app"),
      tab(11, "http://192.168.1.10:8080/"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.ungrouped).toEqual([10, 11]);
  });

  it("sorts groups by size descending, breaking ties by domain name", () => {
    const tabs = [
      ...tabsOn("bbb.com", 3, 1),
      ...tabsOn("aaa.com", 3, 10),
      ...tabsOn("ccc.com", 5, 20),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups.map((group) => group.key)).toEqual([
      "domain:ccc.com", // 5 tabs
      "domain:aaa.com", // 3 tabs, alphabetically first
      "domain:bbb.com", // 3 tabs
    ]);
  });

  it("caps the number of groups at maxGroups, keeping the largest", () => {
    const tabs = [
      ...tabsOn("small.com", 3, 1),
      ...tabsOn("large.com", 9, 10),
      ...tabsOn("medium.com", 6, 30),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3, maxGroups: 2 }));

    expect(plan.groups.map((group) => group.key)).toEqual([
      "domain:large.com",
      "domain:medium.com",
    ]);
    // The rejected group's tabs are not lost — they fall through to ungrouped.
    expect(plan.ungrouped).toEqual([1, 2, 3]);
  });

  it("produces byte-identical output for shuffled but equivalent input", () => {
    const tabs = [...tabsOn("github.com", 4, 1), ...tabsOn("news.com", 3, 10)];
    const shuffled = [tabs[4], tabs[0], tabs[6], tabs[2], tabs[1], tabs[5], tabs[3]].filter(
      (candidate): candidate is TabInfo => candidate !== undefined,
    );

    const fromOrdered = buildPlan(WINDOW, tabs, config());
    const fromShuffled = buildPlan(WINDOW, shuffled, config());

    expect(JSON.stringify(fromShuffled)).toBe(JSON.stringify(fromOrdered));
  });

  it("assigns each domain the same colour on every run", () => {
    const first = buildPlan(WINDOW, tabsOn("github.com", 3), config());
    const second = buildPlan(WINDOW, tabsOn("github.com", 3, 100), config());

    expect(first.groups[0]?.color).toBe(second.groups[0]?.color);
  });

  it("writes a reason a human can check", () => {
    const plan = buildPlan(WINDOW, tabsOn("github.com", 4), config());

    expect(plan.groups[0]?.reason).toBe("4 tabs from github.com");
  });
});

describe("buildPlan — duplicates", () => {
  it("keeps the leftmost tab and proposes closing the rest", () => {
    const tabs = [
      tab(1, "https://example.com/a", { index: 5 }),
      tab(2, "https://example.com/a", { index: 2 }),
      tab(3, "https://example.com/a", { index: 9 }),
    ];
    const plan = buildPlan(WINDOW, tabs, config());

    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.keep).toBe(2);
    expect(plan.duplicates[0]?.close).toEqual([1, 3]);
    expect(plan.stats.wouldClose).toBe(2);
  });

  it("treats tracking parameters and www as the same page", () => {
    const tabs = [
      tab(1, "https://example.com/a"),
      tab(2, "https://www.example.com/a?utm_source=newsletter"),
    ];
    const plan = buildPlan(WINDOW, tabs, config());

    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.close).toEqual([2]);
  });

  it("does not treat hash routes as duplicates of each other", () => {
    const tabs = [tab(1, "https://app.com/#/inbox"), tab(2, "https://app.com/#/settings")];
    const plan = buildPlan(WINDOW, tabs, config());

    expect(plan.duplicates).toEqual([]);
  });

  it("never leaves a closed tab inside a group proposal", () => {
    // Four tabs on one domain, two of them the same page. The group must contain
    // the three survivors, or the preview would show a group that shrinks on apply.
    const tabs = [
      tab(1, "https://github.com/a"),
      tab(2, "https://github.com/a"),
      tab(3, "https://github.com/b"),
      tab(4, "https://github.com/c"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.duplicates[0]?.close).toEqual([2]);
    expect(plan.groups[0]?.tabIds).toEqual([1, 3, 4]);
    expect(plan.groups[0]?.tabIds).not.toContain(2);
  });

  it("can be switched off, and then groups every tab", () => {
    const tabs = [
      tab(1, "https://github.com/a"),
      tab(2, "https://github.com/a"),
      tab(3, "https://github.com/b"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3, detectDuplicates: false }));

    expect(plan.duplicates).toEqual([]);
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
  });

  it("still lists a spared cluster, but puts its tabs back into grouping", () => {
    const tabs = [
      tab(1, "https://github.com/a"),
      tab(2, "https://github.com/a"),
      tab(3, "https://github.com/b"),
      tab(4, "https://github.com/c"),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ minGroupSize: 3, spareDuplicateCanonicals: ["https://github.com/a"] }),
    );

    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.spare).toBe(true);
    expect(plan.duplicates[0]?.close).toEqual([2]);
    expect(plan.stats.wouldClose).toBe(0);
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3, 4]);
  });

  it("only counts non-spared clusters toward wouldClose", () => {
    const tabs = [
      tab(1, "https://github.com/a"),
      tab(2, "https://github.com/a"),
      tab(3, "https://news.com/x"),
      tab(4, "https://news.com/x"),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ spareDuplicateCanonicals: ["https://github.com/a"] }),
    );

    expect(plan.duplicates.map((cluster) => cluster.canonicalUrl)).toEqual([
      "https://github.com/a",
      "https://news.com/x",
    ]);
    expect(plan.duplicates[0]?.spare).toBe(true);
    expect(plan.duplicates[1]?.spare).toBe(false);
    expect(plan.stats.wouldClose).toBe(1);
  });

  it("ignores spareCanonicals when detection is off", () => {
    const tabs = [tab(1, "https://example.com/a"), tab(2, "https://example.com/a")];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({
        detectDuplicates: false,
        spareDuplicateCanonicals: ["https://example.com/a"],
      }),
    );

    expect(plan.duplicates).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2]);
  });

  it("ignores tabs whose url has no canonical form", () => {
    const tabs = [tab(1, "about:blank"), tab(2, "about:blank")];
    const plan = buildPlan(WINDOW, tabs, config());

    expect(plan.duplicates).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2]);
  });
});

describe("buildPlan — stats and scale", () => {
  it("reports what the preview needs to summarise the plan", () => {
    const tabs = [
      ...tabsOn("github.com", 3, 1),
      ...tabsOn("news.com", 3, 10),
      tab(50, "https://example.com/a"),
      tab(51, "https://example.com/a"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.stats.tabCount).toBe(8);
    expect(plan.stats.groupCount).toBe(2);
    expect(plan.stats.wouldClose).toBe(1);
  });

  it("handles 500 tabs well inside a frame", () => {
    const tabs = Array.from({ length: 500 }, (_, i) =>
      tab(i + 1, `https://site${i % 40}.com/page${i}`),
    );

    const started = performance.now();
    const plan = buildPlan(WINDOW, tabs, config());
    const elapsed = performance.now() - started;

    expect(plan.stats.tabCount).toBe(500);
    expect(elapsed).toBeLessThan(16);
  });
});
