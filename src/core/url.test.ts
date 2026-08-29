import { describe, expect, it } from "vitest";
import { canonicalUrl, hostnameOf, hostnameOfPattern, registrableDomain } from "./url";

describe("registrableDomain", () => {
  it("strips subdomains down to the registrable domain", () => {
    expect(registrableDomain("https://www.github.com/foo")).toBe("github.com");
    expect(registrableDomain("https://github.com/foo")).toBe("github.com");
    expect(registrableDomain("https://mail.google.com/mail/u/0")).toBe("google.com");
    expect(registrableDomain("https://docs.google.com/document/d/1")).toBe("google.com");
  });

  it("honours the Public Suffix List instead of guessing at dots", () => {
    // github.io is itself a public suffix, so the registrable domain keeps the user part.
    expect(registrableDomain("https://ben.github.io/project")).toBe("ben.github.io");
    // Two-level suffix: naive "last two labels" would wrongly return co.uk.
    expect(registrableDomain("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  });

  it("returns null for hosts that have no registrable domain", () => {
    expect(registrableDomain("http://localhost:3000/")).toBeNull();
    expect(registrableDomain("http://192.168.1.10:8080/")).toBeNull();
    expect(registrableDomain("http://[::1]:8080/")).toBeNull();
  });

  it("returns null for anything that is not http or https", () => {
    expect(registrableDomain("about:blank")).toBeNull();
    expect(registrableDomain("moz-extension://abc/page.html")).toBeNull();
    expect(registrableDomain("view-source:https://x.com")).toBeNull();
    expect(registrableDomain("file:///home/ben/notes.txt")).toBeNull();
    expect(registrableDomain("chrome://flags")).toBeNull();
  });

  it("returns null rather than throwing on junk input", () => {
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain("not a url at all")).toBeNull();
    expect(registrableDomain("https://")).toBeNull();
  });

  it("compares unicode and punycode hosts as the same domain", () => {
    const unicode = registrableDomain("https://münchen.de/page");
    const puny = registrableDomain("https://xn--mnchen-3ya.de/page");
    expect(unicode).toBe(puny);
    expect(unicode).not.toBeNull();
  });
});

describe("canonicalUrl", () => {
  it("treats www and bare host as the same page", () => {
    expect(canonicalUrl("https://www.github.com/foo")).toBe(canonicalUrl("https://github.com/foo"));
  });

  it("only strips a leading www., not lookalike labels", () => {
    // www2 and wwww are ordinary subdomains and may serve different content.
    expect(canonicalUrl("https://www2.example.com/a")).not.toBe(
      canonicalUrl("https://example.com/a"),
    );
  });

  it("lowercases scheme and host but leaves the path alone", () => {
    // Paths are case-sensitive on most servers; /Foo and /foo are not the same page.
    expect(canonicalUrl("HTTPS://GitHub.COM/Foo")).toBe("https://github.com/Foo");
  });

  it("drops a trailing dot on the host", () => {
    expect(canonicalUrl("https://github.com./foo")).toBe("https://github.com/foo");
  });

  it("drops the default port but keeps a non-default one", () => {
    expect(canonicalUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(canonicalUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(canonicalUrl("http://example.com:8080/a")).toBe("http://example.com:8080/a");
  });

  it("removes known tracking parameters", () => {
    expect(canonicalUrl("https://example.com/a?utm_source=x&utm_campaign=y")).toBe(
      "https://example.com/a",
    );
    expect(canonicalUrl("https://example.com/a?fbclid=x&gclid=y&mc_eid=z&igshid=w&ref_src=v")).toBe(
      "https://example.com/a",
    );
  });

  it("keeps parameters it does not recognise, including bare ref", () => {
    // `ref` is load-bearing on GitHub, npm and most docs sites — see D-004.
    expect(canonicalUrl("https://example.com/a?ref=main")).toBe("https://example.com/a?ref=main");
    expect(canonicalUrl("https://example.com/a?id=42")).toBe("https://example.com/a?id=42");
  });

  it("sorts remaining parameters so ordering does not defeat equality", () => {
    expect(canonicalUrl("https://example.com/a?b=2&a=1")).toBe(
      canonicalUrl("https://example.com/a?a=1&b=2"),
    );
    expect(canonicalUrl("https://example.com/a?b=2&a=1")).toBe("https://example.com/a?a=1&b=2");
  });

  it("drops an ordinary fragment", () => {
    expect(canonicalUrl("https://example.com/page#section-3")).toBe("https://example.com/page");
  });

  it("keeps a hash-router fragment, which addresses a different page", () => {
    // In a hash-routed SPA these are two genuinely different pages; merging them
    // would silently propose closing one as a duplicate. See DESIGN.md.
    expect(canonicalUrl("https://x.com/#/route")).toBe("https://x.com/#/route");
    expect(canonicalUrl("https://x.com/#/route")).not.toBe(canonicalUrl("https://x.com/#/other"));
  });

  it("returns null for anything that is not http or https", () => {
    expect(canonicalUrl("about:blank")).toBeNull();
    expect(canonicalUrl("moz-extension://abc/page.html")).toBeNull();
    expect(canonicalUrl("view-source:https://x.com")).toBeNull();
    expect(canonicalUrl("file:///home/ben/notes.txt")).toBeNull();
    expect(canonicalUrl("data:text/plain,hello")).toBeNull();
  });

  it("returns null rather than throwing on junk input", () => {
    expect(canonicalUrl("")).toBeNull();
    expect(canonicalUrl("not a url at all")).toBeNull();
  });

  it("keeps hosts without a registrable domain usable", () => {
    // localhost has no eTLD+1, but it is still a real page that can have duplicates.
    expect(canonicalUrl("http://localhost:3000/app")).toBe("http://localhost:3000/app");
  });

  it("handles a pathologically long url without blowing up", () => {
    const long = `https://example.com/a?q=${"x".repeat(100_000)}`;
    const started = performance.now();
    expect(canonicalUrl(long)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("hostnameOf", () => {
  it("strips www and a trailing dot the same way as canonicalUrl", () => {
    expect(hostnameOf("https://www.github.com/foo")).toBe("github.com");
    expect(hostnameOf("https://github.com./foo")).toBe("github.com");
  });

  it("leaves www.com whole and does not strip www2", () => {
    expect(hostnameOf("https://www.com/")).toBe("www.com");
    expect(hostnameOf("https://www2.example.com/a")).toBe("www2.example.com");
  });

  it("compares unicode and punycode hosts as the same host", () => {
    expect(hostnameOf("https://münchen.de/page")).toBe(
      hostnameOf("https://xn--mnchen-3ya.de/page"),
    );
  });

  it("returns null for anything that is not http or https", () => {
    expect(hostnameOf("about:blank")).toBeNull();
  });
});

describe("hostnameOfPattern", () => {
  it("skips empty and whitespace-only patterns", () => {
    expect(hostnameOfPattern("")).toBeNull();
    expect(hostnameOfPattern("   ")).toBeNull();
  });

  it("normalises like hostnameOf so www.GitHub.com. matches github.com", () => {
    expect(hostnameOfPattern("www.GitHub.com.")).toBe("github.com");
    expect(hostnameOfPattern("github.com")).toBe(hostnameOf("https://www.github.com/foo"));
  });
});
