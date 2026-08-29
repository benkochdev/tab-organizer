import { describe, expect, it } from "vitest";
import { MS_PER_DAY } from "./archive";
import { buildPlan } from "./plan";
import {
  type Config,
  DEFAULT_CONFIG,
  type DomainRule,
  type ExistingGroup,
  type TabInfo,
} from "./types";

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

function rule(pattern: string, action: DomainRule["action"], value = ""): DomainRule {
  return { pattern, action, value };
}

function existing(
  id: number,
  urls: string[],
  title = "GitHub",
  color: ExistingGroup["color"] = "blue",
): ExistingGroup {
  return { id, title, color, urls };
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
    expect(plan.groups[0]?.label).toBe("GitHub");
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

  it("labels a Google-only pile Google, even when every tab is Gmail", () => {
    const tabs = [
      tab(1, "https://mail.google.com/a"),
      tab(2, "https://mail.google.com/b"),
      tab(3, "https://mail.google.com/c"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:google.com");
    expect(plan.groups[0]?.label).toBe("Google");
  });

  it("still merges mixed Google products when none of them reach minGroupSize", () => {
    const tabs = [
      tab(1, "https://mail.google.com/inbox"),
      tab(2, "https://docs.google.com/doc/1"),
      tab(3, "https://drive.google.com/file/2"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:google.com");
    expect(plan.groups[0]?.label).toBe("Google");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
  });

  it("keeps mixed Google together when only one product reaches minGroupSize", () => {
    const tabs = [
      tab(1, "https://mail.google.com/a"),
      tab(2, "https://mail.google.com/b"),
      tab(3, "https://mail.google.com/c"),
      tab(4, "https://docs.google.com/document/d/1"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:google.com");
    expect(plan.groups[0]?.label).toBe("Google");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3, 4]);
  });

  it("splits Google when two products each reach minGroupSize", () => {
    const tabs = [
      tab(1, "https://mail.google.com/a"),
      tab(2, "https://mail.google.com/b"),
      tab(3, "https://mail.google.com/c"),
      tab(4, "https://docs.google.com/document/d/1"),
      tab(5, "https://docs.google.com/document/d/2"),
      tab(6, "https://docs.google.com/document/d/3"),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups.map((group) => group.key)).toEqual([
      "domain:google.com:docs",
      "domain:google.com:gmail",
    ]);
    expect(plan.groups.map((group) => group.label)).toEqual(["Docs", "Gmail"]);
  });

  it("keeps one Wikipedia group when every article is about the same thing", () => {
    const tabs = [
      tab(1, "https://en.wikipedia.org/wiki/Toad", { title: "Toad - Wikipedia" }),
      tab(2, "https://en.wikipedia.org/wiki/Common_toad", { title: "Common toad - Wikipedia" }),
      tab(3, "https://en.wikipedia.org/wiki/True_toad", { title: "True toad - Wikipedia" }),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:wikipedia.org");
    expect(plan.groups[0]?.label).toBe("Wikipedia");
  });

  it("keeps mixed Wikipedia together when only one topic reaches minGroupSize", () => {
    const tabs = [
      tab(1, "https://en.wikipedia.org/wiki/Toad", { title: "Toad - Wikipedia" }),
      tab(2, "https://en.wikipedia.org/wiki/Common_toad", { title: "Common toad - Wikipedia" }),
      tab(3, "https://en.wikipedia.org/wiki/True_toad", { title: "True toad - Wikipedia" }),
      tab(4, "https://en.wikipedia.org/wiki/Cake", { title: "Cake - Wikipedia" }),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:wikipedia.org");
    expect(plan.groups[0]?.label).toBe("Wikipedia");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3, 4]);
  });

  it("splits Wikipedia when two topics each reach minGroupSize", () => {
    const tabs = [
      tab(1, "https://en.wikipedia.org/wiki/Toad", { title: "Toad - Wikipedia" }),
      tab(2, "https://en.wikipedia.org/wiki/Common_toad", { title: "Common toad - Wikipedia" }),
      tab(3, "https://en.wikipedia.org/wiki/True_toad", { title: "True toad - Wikipedia" }),
      tab(4, "https://en.wikipedia.org/wiki/Cake", { title: "Cake - Wikipedia" }),
      tab(5, "https://en.wikipedia.org/wiki/Chocolate_cake", {
        title: "Chocolate cake - Wikipedia",
      }),
      tab(6, "https://en.wikipedia.org/wiki/Birthday_cake", { title: "Birthday cake - Wikipedia" }),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3 }));

    expect(plan.groups.map((group) => group.key).sort()).toEqual([
      "domain:wikipedia.org:cake",
      "domain:wikipedia.org:toad",
    ]);
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

describe("buildPlan — domain rules", () => {
  it("never-groups matching tabs instead of clustering them", () => {
    const tabs = [...tabsOn("github.com", 3, 1), ...tabsOn("amazon.de", 3, 10)];
    const plan = buildPlan(WINDOW, tabs, config({ rules: [rule("amazon.de", "never-group")] }));

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("domain:github.com");
    expect(plan.ungrouped).toEqual([10, 11, 12]);
  });

  it("names a site even when the pile is below minGroupSize", () => {
    const plan = buildPlan(
      WINDOW,
      tabsOn("github.com", 1),
      config({ minGroupSize: 3, rules: [rule("github.com", "always-name", "Work")] }),
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("rule:Work");
    expect(plan.groups[0]?.label).toBe("Work");
    expect(plan.groups[0]?.tabIds).toEqual([1]);
    expect(plan.groups[0]?.reason).toBe("1 tab named Work by rule github.com");
  });

  it("merges two sites that share a trimmed value into one group", () => {
    const tabs = [...tabsOn("amazon.de", 3, 1), ...tabsOn("amazon.com", 3, 10)];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({
        rules: [
          rule("amazon.de", "merge-into", "Amazon"),
          rule("amazon.com", "merge-into", " Amazon "),
        ],
      }),
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("rule:Amazon");
    expect(plan.groups[0]?.label).toBe("Amazon");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3, 10, 11, 12]);
    expect(plan.groups[0]?.reason).toBe("6 tabs merged by rule amazon.com, amazon.de");
  });

  it("treats merging two hosts on one site as a no-op vs default site grouping", () => {
    const tabs = [
      tab(1, "https://mail.foo.com/a"),
      tab(2, "https://mail.foo.com/b"),
      tab(3, "https://mail.foo.com/c"),
      tab(4, "https://app.foo.com/a"),
      tab(5, "https://app.foo.com/b"),
      tab(6, "https://app.foo.com/c"),
    ];
    const merged = buildPlan(
      WINDOW,
      tabs,
      config({
        rules: [
          rule("mail.foo.com", "merge-into", "Foo"),
          rule("app.foo.com", "merge-into", "Foo"),
        ],
      }),
    );
    const defaults = buildPlan(WINDOW, tabs, config());

    expect(merged.groups).toEqual(defaults.groups);
    expect(merged.groups[0]?.key).toBe("domain:foo.com");
  });

  it("lets a host rule beat a site rule on the same tabs", () => {
    const tabs = [...tabsOn("github.com", 3, 1), ...tabsOn("gist.github.com", 3, 10)];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({
        rules: [rule("github.com", "always-name", "Work"), rule("gist.github.com", "never-group")],
      }),
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("rule:Work");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(plan.ungrouped).toEqual([10, 11, 12]);
  });

  it("skips an empty pattern and an empty name, so domain clustering still runs", () => {
    const plan = buildPlan(
      WINDOW,
      tabsOn("github.com", 3),
      config({
        rules: [rule("", "always-name", "Work"), rule("github.com", "always-name", "  ")],
      }),
    );

    expect(plan.groups[0]?.key).toBe("domain:github.com");
    expect(plan.groups[0]?.label).toBe("GitHub");
  });

  it("fills maxGroups with rule groups first, leftover slots go to domains", () => {
    const tabs = [
      ...tabsOn("a.com", 5, 1),
      ...tabsOn("b.com", 4, 10),
      ...tabsOn("news.com", 10, 20),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({
        maxGroups: 2,
        rules: [rule("a.com", "always-name", "A"), rule("b.com", "always-name", "B")],
      }),
    );

    expect(plan.groups.map((group) => group.key)).toEqual(["rule:A", "rule:B"]);
    expect(plan.ungrouped).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it("still detects duplicates before rules see the tabs", () => {
    const tabs = [
      tab(1, "https://github.com/a"),
      tab(2, "https://github.com/a"),
      tab(3, "https://github.com/b"),
      tab(4, "https://github.com/c"),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ minGroupSize: 3, rules: [rule("github.com", "always-name", "Work")] }),
    );

    expect(plan.duplicates[0]?.close).toEqual([2]);
    expect(plan.groups[0]?.key).toBe("rule:Work");
    expect(plan.groups[0]?.tabIds).toEqual([1, 3, 4]);
    expect(plan.groups[0]?.tabIds).not.toContain(2);
  });

  it("peels one host into a merge group and leaves the rest of the site", () => {
    const tabs = [
      tab(1, "https://mail.foo.com/a"),
      tab(2, "https://mail.foo.com/b"),
      tab(3, "https://mail.foo.com/c"),
      tab(4, "https://app.foo.com/a"),
      tab(5, "https://app.foo.com/b"),
      tab(6, "https://app.foo.com/c"),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ rules: [rule("mail.foo.com", "merge-into", "Mail")] }),
    );

    const mail = plan.groups.find((group) => group.key === "rule:Mail");
    const rest = plan.groups.find((group) => group.key === "domain:foo.com");
    expect(mail?.tabIds).toEqual([1, 2, 3]);
    expect(rest?.tabIds).toEqual([4, 5, 6]);
  });

  it("gives leftover maxGroups slots to domain clustering", () => {
    const tabs = [...tabsOn("github.com", 3, 1), ...tabsOn("news.com", 5, 10)];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ maxGroups: 2, rules: [rule("github.com", "always-name", "Work")] }),
    );

    expect(plan.groups.map((group) => group.key)).toEqual(["domain:news.com", "rule:Work"]);
  });
});

describe("buildPlan — join existing groups", () => {
  it("adds one leftover tab to an existing site group", () => {
    const plan = buildPlan(WINDOW, [tab(1, "https://github.com/new")], config(), [
      existing(5, ["https://github.com/old"]),
    ]);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("existing:5");
    expect(plan.groups[0]?.existingGroupId).toBe(5);
    expect(plan.groups[0]?.tabIds).toEqual([1]);
    expect(plan.ungrouped).toEqual([]);
  });

  it("adds several leftover tabs to the existing group instead of creating a duplicate", () => {
    const plan = buildPlan(WINDOW, tabsOn("github.com", 3), config({ minGroupSize: 3 }), [
      existing(5, ["https://github.com/already"]),
    ]);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("existing:5");
    expect(plan.groups.map((group) => group.key)).not.toContain("domain:github.com");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
  });

  it("does not join never-group tabs to an existing group of that site", () => {
    const plan = buildPlan(
      WINDOW,
      tabsOn("amazon.de", 3),
      config({ rules: [rule("amazon.de", "never-group")] }),
      [existing(5, ["https://amazon.de/old"], "Amazon")],
    );

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2, 3]);
  });

  it("picks the larger existing group when two share the same site", () => {
    const plan = buildPlan(WINDOW, [tab(1, "https://github.com/new")], config(), [
      existing(8, ["https://github.com/a"], "GitHub"),
      existing(
        3,
        ["https://github.com/a", "https://github.com/b", "https://github.com/c"],
        "GitHub",
      ),
    ]);

    expect(plan.groups[0]?.existingGroupId).toBe(3);
  });

  it("does not put a Docs tab into an existing Gmail group", () => {
    const plan = buildPlan(WINDOW, [tab(1, "https://docs.google.com/doc")], config(), [
      existing(2, ["https://mail.google.com/a", "https://mail.google.com/b"], "Gmail"),
    ]);

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1]);
  });

  it("joins amazon.de to an existing Amazon group via merge-into title", () => {
    const plan = buildPlan(
      WINDOW,
      [tab(1, "https://amazon.de/x")],
      config({ rules: [rule("amazon.de", "merge-into", "Amazon")] }),
      [existing(9, ["https://amazon.com/old"], "Amazon")],
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.existingGroupId).toBe(9);
    expect(plan.groups[0]?.key).toBe("existing:9");
  });

  it("does not count join proposals against maxGroups", () => {
    const tabs = [tab(1, "https://github.com/new"), ...tabsOn("news.com", 5, 10)];
    const plan = buildPlan(WINDOW, tabs, config({ maxGroups: 1, minGroupSize: 3 }), [
      existing(5, ["https://github.com/old"]),
    ]);

    expect(plan.groups.map((group) => group.key).sort()).toEqual(["domain:news.com", "existing:5"]);
  });

  it("still detects duplicates before joining the survivors", () => {
    const tabs = [
      tab(1, "https://github.com/a"),
      tab(2, "https://github.com/a"),
      tab(3, "https://github.com/b"),
    ];
    const plan = buildPlan(WINDOW, tabs, config(), [existing(5, ["https://github.com/old"])]);

    expect(plan.duplicates[0]?.close).toEqual([2]);
    expect(plan.groups[0]?.tabIds).toEqual([1, 3]);
    expect(plan.groups[0]?.tabIds).not.toContain(2);
  });

  it("leaves a single tab ungrouped when no existing group matches", () => {
    const plan = buildPlan(WINDOW, [tab(1, "https://github.com/new")], config({ minGroupSize: 3 }));

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1]);
  });
});

describe("buildPlan — topics", () => {
  it("does not cluster leftovers by title when grouping mode is sites", () => {
    const tabs = [
      tab(1, "https://a.com/x", { title: "Lisbon hotels" }),
      tab(2, "https://b.com/x", { title: "Lisbon map" }),
      tab(3, "https://c.com/x", { title: "Lisbon weather" }),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3, groupingMode: "sites" }));

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2, 3]);
  });

  it("clusters leftovers by title after site grouping", () => {
    const tabs = [
      ...tabsOn("github.com", 3, 1),
      tab(10, "https://a.com/x", { title: "Lisbon hotels" }),
      tab(11, "https://b.com/x", { title: "Lisbon map" }),
      tab(12, "https://c.com/x", { title: "Lisbon weather" }),
    ];
    const plan = buildPlan(WINDOW, tabs, config({ minGroupSize: 3, groupingMode: "topics" }));

    expect(plan.groups.map((group) => group.key).sort()).toEqual([
      "domain:github.com",
      "topic:lisbon",
    ]);
    const github = plan.groups.find((group) => group.key === "domain:github.com");
    const lisbon = plan.groups.find((group) => group.key === "topic:lisbon");
    expect(github?.tabIds).toEqual([1, 2, 3]);
    expect(lisbon?.tabIds).toEqual([10, 11, 12]);
  });

  it("does not pull never-group tabs into a topic", () => {
    const tabs = [
      tab(1, "https://amazon.de/x", { title: "Lisbon sale" }),
      tab(2, "https://amazon.de/y", { title: "Lisbon deal" }),
      tab(3, "https://amazon.de/z", { title: "Lisbon shop" }),
      tab(10, "https://a.com/x", { title: "Lisbon hotels" }),
      tab(11, "https://b.com/x", { title: "Lisbon map" }),
      tab(12, "https://c.com/x", { title: "Lisbon weather" }),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({
        minGroupSize: 3,
        groupingMode: "topics",
        rules: [rule("amazon.de", "never-group")],
      }),
    );

    expect(plan.groups.map((group) => group.key)).toEqual(["topic:lisbon"]);
    expect(plan.groups[0]?.tabIds).toEqual([10, 11, 12]);
    expect(plan.ungrouped).toEqual([1, 2, 3]);
  });

  it("gives leftover maxGroups slots to topics after site groups", () => {
    const tabs = [
      ...tabsOn("github.com", 3, 1),
      tab(10, "https://a.com/x", { title: "Lisbon hotels" }),
      tab(11, "https://b.com/x", { title: "Lisbon map" }),
      tab(12, "https://c.com/x", { title: "Lisbon weather" }),
      tab(13, "https://d.com/x", { title: "Lisbon flights" }),
      tab(20, "https://e.com/x", { title: "Bergen hotels" }),
      tab(21, "https://f.com/x", { title: "Bergen map" }),
      tab(22, "https://g.com/x", { title: "Bergen weather" }),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ minGroupSize: 3, maxGroups: 2, groupingMode: "topics" }),
    );

    expect(plan.groups.map((group) => group.key).sort()).toEqual([
      "domain:github.com",
      "topic:lisbon",
    ]);
    expect(plan.ungrouped).toEqual([20, 21, 22]);
  });
});

describe("buildPlan — archive", () => {
  const now = 30 * MS_PER_DAY;
  const idle = now - 15 * MS_PER_DAY;
  const fresh = now - MS_PER_DAY;

  it("does not archive when the toggle is off", () => {
    const tabs = tabsOn("github.com", 3).map((item) => ({ ...item, lastAccessed: idle }));
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ archiveEnabled: false, archiveDays: 14 }),
      [],
      now,
    );

    expect(plan.groups[0]?.key).toBe("domain:github.com");
  });

  it("moves idle tabs into Archive even when they would form a site group", () => {
    const tabs = [
      tab(1, "https://github.com/a", { lastAccessed: idle }),
      tab(2, "https://github.com/b", { lastAccessed: idle }),
      tab(3, "https://github.com/c", { lastAccessed: idle }),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ archiveEnabled: true, archiveDays: 14, minGroupSize: 3 }),
      [],
      now,
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.key).toBe("archive");
    expect(plan.groups[0]?.label).toBe("Archive");
    expect(plan.groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(plan.groups[0]?.reason).toBe("3 tabs unused for 14 days");
  });

  it("leaves recently used tabs for site grouping", () => {
    const tabs = [
      tab(1, "https://github.com/a", { lastAccessed: fresh }),
      tab(2, "https://github.com/b", { lastAccessed: fresh }),
      tab(3, "https://github.com/c", { lastAccessed: fresh }),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ archiveEnabled: true, archiveDays: 14, minGroupSize: 3 }),
      [],
      now,
    );

    expect(plan.groups[0]?.key).toBe("domain:github.com");
  });

  it("archives a single idle tab", () => {
    const plan = buildPlan(
      WINDOW,
      [tab(1, "https://news.com/old", { lastAccessed: idle })],
      config({ archiveEnabled: true, archiveDays: 14, minGroupSize: 3 }),
      [],
      now,
    );

    expect(plan.groups[0]?.key).toBe("archive");
    expect(plan.groups[0]?.tabIds).toEqual([1]);
    expect(plan.groups[0]?.reason).toBe("1 tab unused for 14 days");
  });

  it("does not archive never-group tabs", () => {
    const tabs = [
      tab(1, "https://amazon.de/a", { lastAccessed: idle }),
      tab(2, "https://amazon.de/b", { lastAccessed: idle }),
      tab(3, "https://amazon.de/c", { lastAccessed: idle }),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({
        archiveEnabled: true,
        archiveDays: 14,
        rules: [rule("amazon.de", "never-group")],
      }),
      [],
      now,
    );

    expect(plan.groups).toEqual([]);
    expect(plan.ungrouped).toEqual([1, 2, 3]);
  });

  it("adds idle tabs to an existing Archive group instead of creating another", () => {
    const plan = buildPlan(
      WINDOW,
      [tab(1, "https://news.com/old", { lastAccessed: idle })],
      config({ archiveEnabled: true, archiveDays: 14 }),
      [existing(9, ["https://old.com/x"], "Archive", "grey")],
      now,
    );

    expect(plan.groups[0]?.key).toBe("archive");
    expect(plan.groups[0]?.existingGroupId).toBe(9);
    expect(plan.groups[0]?.color).toBe("grey");
  });

  it("still detects duplicates before archiving survivors", () => {
    const tabs = [
      tab(1, "https://news.com/a", { lastAccessed: idle }),
      tab(2, "https://news.com/a", { lastAccessed: idle }),
      tab(3, "https://news.com/b", { lastAccessed: idle }),
    ];
    const plan = buildPlan(
      WINDOW,
      tabs,
      config({ archiveEnabled: true, archiveDays: 14 }),
      [],
      now,
    );

    expect(plan.duplicates[0]?.close).toEqual([2]);
    expect(plan.groups[0]?.tabIds).toEqual([1, 3]);
    expect(plan.groups[0]?.tabIds).not.toContain(2);
  });
});
