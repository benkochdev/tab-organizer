import { describe, expect, it } from "vitest";
import { sortTabIds } from "./sort";
import type { TabInfo } from "./types";

function tab(id: number, url: string, title: string, index = id): TabInfo {
  return { id, windowId: 1, index, url, title, lastAccessed: 0 };
}

describe("sortTabIds", () => {
  it("orders by registrable domain, then URL, then index", () => {
    const tabs = [
      tab(1, "https://zeta.com/z", "Z"),
      tab(2, "https://alpha.com/b", "B"),
      tab(3, "https://alpha.com/a", "A"),
    ];

    expect(sortTabIds(tabs, "domain")).toEqual([3, 2, 1]);
  });

  it("orders by title case-insensitively, then index", () => {
    const tabs = [
      tab(1, "https://a.com/1", "zeta"),
      tab(2, "https://b.com/2", "Alpha"),
      tab(3, "https://c.com/3", "alpha"),
    ];

    expect(sortTabIds(tabs, "title")).toEqual([2, 3, 1]);
  });
});
