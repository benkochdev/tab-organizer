import { describe, expect, it } from "vitest";
import { clusterByTopic } from "./topics";
import { type Config, DEFAULT_CONFIG, type TabInfo } from "./types";

const WINDOW = 1;

function tab(id: number, url: string, title: string): TabInfo {
  return {
    id,
    windowId: WINDOW,
    index: id,
    url,
    title,
    lastAccessed: 0,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("clusterByTopic", () => {
  it("groups leftover tabs that share a title token across sites", () => {
    const tabs = [
      tab(1, "https://booking.com/lisbon", "Lisbon hotels"),
      tab(2, "https://maps.example.com/lisbon", "Lisbon map"),
      tab(3, "https://wiki.example.org/lisbon", "Lisbon - Wiki"),
    ];
    const { groups, remaining } = clusterByTopic(tabs, config({ minGroupSize: 3 }));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("topic:lisbon");
    expect(groups[0]?.label).toBe("Lisbon");
    expect(groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(groups[0]?.reason).toBe("3 tabs about lisbon");
    expect(remaining).toEqual([]);
  });

  it("leaves a shared token below minGroupSize ungrouped", () => {
    const tabs = [
      tab(1, "https://a.com/x", "Lisbon hotels"),
      tab(2, "https://b.com/x", "Lisbon map"),
    ];
    const { groups, remaining } = clusterByTopic(tabs, config({ minGroupSize: 3 }));

    expect(groups).toEqual([]);
    expect(remaining.map((item) => item.id)).toEqual([1, 2]);
  });

  it("peels two topics when each reaches minGroupSize", () => {
    const tabs = [
      tab(1, "https://a.com/l", "Lisbon hotels"),
      tab(2, "https://b.com/l", "Lisbon map"),
      tab(3, "https://c.com/l", "Lisbon weather"),
      tab(4, "https://d.com/b", "Bergen hotels"),
      tab(5, "https://e.com/b", "Bergen map"),
      tab(6, "https://f.com/b", "Bergen weather"),
    ];
    const { groups } = clusterByTopic(tabs, config({ minGroupSize: 3 }));

    expect(groups.map((group) => group.key).sort()).toEqual(["topic:bergen", "topic:lisbon"]);
  });

  it("still groups when one token covers the whole remainder", () => {
    const tabs = [
      tab(1, "https://a.com/x", "Lisbon travel guide"),
      tab(2, "https://b.com/x", "Lisbon travel guide"),
      tab(3, "https://c.com/x", "Lisbon travel guide"),
    ];
    const { groups } = clusterByTopic(tabs, config({ minGroupSize: 3 }));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("topic:lisbon");
  });

  it("does not cluster on stopwords alone", () => {
    const tabs = [
      tab(1, "https://a.com/x", "The new www"),
      tab(2, "https://b.com/x", "The new www"),
      tab(3, "https://c.com/x", "The new www"),
    ];
    const { groups, remaining } = clusterByTopic(tabs, config({ minGroupSize: 3 }));

    expect(groups).toEqual([]);
    expect(remaining).toHaveLength(3);
  });

  it("keeps the largest topics when over maxGroups", () => {
    const tabs = [
      tab(1, "https://a.com/l", "Lisbon one"),
      tab(2, "https://b.com/l", "Lisbon two"),
      tab(3, "https://c.com/l", "Lisbon three"),
      tab(4, "https://d.com/l", "Lisbon four"),
      tab(5, "https://e.com/b", "Bergen one"),
      tab(6, "https://f.com/b", "Bergen two"),
      tab(7, "https://g.com/b", "Bergen three"),
    ];
    const { groups, remaining } = clusterByTopic(tabs, config({ minGroupSize: 3, maxGroups: 1 }));

    expect(groups.map((group) => group.key)).toEqual(["topic:lisbon"]);
    expect(remaining.map((item) => item.id)).toEqual([5, 6, 7]);
  });

  it("is stable for shuffled input", () => {
    const tabs = [
      tab(1, "https://a.com/l", "Lisbon hotels"),
      tab(2, "https://b.com/l", "Lisbon map"),
      tab(3, "https://c.com/l", "Lisbon weather"),
    ];
    const shuffled = [tabs[2], tabs[0], tabs[1]].flatMap((item) =>
      item === undefined ? [] : [item],
    );
    const fromOrdered = clusterByTopic(tabs, config({ minGroupSize: 3 }));
    const fromShuffled = clusterByTopic(shuffled, config({ minGroupSize: 3 }));

    expect(fromShuffled).toEqual(fromOrdered);
  });
});
