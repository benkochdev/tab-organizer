import { describe, expect, it } from "vitest";
import { matchDomainRule } from "./rules";

describe("matchDomainRule", () => {
  it("matches a host pattern against that host only", () => {
    expect(matchDomainRule("mail.foo.com", "https://mail.foo.com/inbox")).toBe("host");
    expect(matchDomainRule("mail.foo.com", "https://app.foo.com/dash")).toBeNull();
  });

  it("matches a site pattern against every host on that site", () => {
    expect(matchDomainRule("github.com", "https://gist.github.com/abc")).toBe("site");
    expect(matchDomainRule("github.com", "https://github.com/foo")).toBe("host");
  });

  it("strips www on the pattern and the tab the same way", () => {
    expect(matchDomainRule("www.github.com", "https://github.com/foo")).toBe("host");
    expect(matchDomainRule("github.com", "https://www.github.com/foo")).toBe("host");
  });

  it("skips an empty or whitespace-only pattern", () => {
    expect(matchDomainRule("", "https://github.com/foo")).toBeNull();
    expect(matchDomainRule("  ", "https://github.com/foo")).toBeNull();
  });

  it("does not treat amazon.de as amazon.com", () => {
    expect(matchDomainRule("amazon.com", "https://amazon.de/x")).toBeNull();
    expect(matchDomainRule("amazon.de", "https://amazon.de/x")).toBe("host");
  });
});
