import { describe, expect, it } from "vitest";
import { joinExistingGroups } from "./join";
import {
  type Config,
  DEFAULT_CONFIG,
  type DomainRule,
  type ExistingGroup,
  type TabInfo,
} from "./types";

const WINDOW = 1;

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

describe("joinExistingGroups", () => {
  it("adds a single tab to a matching existing group", () => {
    const { groups, remaining } = joinExistingGroups(
      [tab(1, "https://github.com/new")],
      [existing(5, ["https://github.com/old"])],
      config(),
    );

    expect(remaining).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("existing:5");
    expect(groups[0]?.existingGroupId).toBe(5);
    expect(groups[0]?.tabIds).toEqual([1]);
    expect(groups[0]?.reason).toBe("add 1 tab to GitHub");
  });

  it("does not join a never-group tab even when the site already has a group", () => {
    const { groups, remaining } = joinExistingGroups(
      [tab(1, "https://amazon.de/x")],
      [existing(5, ["https://amazon.de/old"], "Amazon")],
      config({ rules: [rule("amazon.de", "never-group")] }),
    );

    expect(groups).toEqual([]);
    expect(remaining.map((item) => item.id)).toEqual([1]);
  });

  it("prefers a host match over a site match when two groups could apply", () => {
    const { groups } = joinExistingGroups(
      [tab(1, "https://mail.google.com/inbox")],
      [
        existing(1, ["https://docs.google.com/a", "https://docs.google.com/b"], "Docs"),
        existing(2, ["https://mail.google.com/a"], "Gmail"),
      ],
      config(),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.existingGroupId).toBe(2);
    expect(groups[0]?.label).toBe("Gmail");
  });
});
