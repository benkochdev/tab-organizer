import { getDomain } from "tldts";

/**
 * URL handling for every downstream stage. Two decisions are baked in here and
 * are worth knowing before you change anything:
 *
 * 1. A leading `www.` is stripped. `www.github.com/foo` and `github.com/foo` are
 *    the same page in practice, and treating them as different would leave
 *    obvious duplicates on the table. Only an exact leading `www.` — `www2.` and
 *    friends are ordinary subdomains that may serve different content.
 *
 * 2. The fragment is dropped, *unless* it starts with `#/`. A plain `#section`
 *    is a scroll position within one page. A `#/route` is the near-universal
 *    marker of a hash-routed SPA, where the fragment is the only thing that says
 *    which page you are on — dropping it would merge unrelated tabs and propose
 *    closing one of them as a duplicate.
 *
 * Both functions return null instead of throwing. A tab list contains
 * `about:blank`, `moz-extension://…` and the occasional malformed string; that is
 * normal input here, not an exceptional condition.
 */

/** Query parameters that identify a campaign or a click, never a page. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "fbclid",
  "gclid",
  "mc_eid",
  "ref_src",
  "igshid",
]);

/** Prefix families, where enumerating every parameter is hopeless. */
const TRACKING_PREFIXES: readonly string[] = ["utm_"];

/**
 * Parses `raw` and guarantees the result is an http(s) URL, or null.
 * Every other scheme — about:, moz-extension:, file:, data:, view-source: —
 * is something we neither group nor compare.
 */
function parseHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed;
}

/**
 * `URL` already lowercases the host and converts unicode to punycode, so
 * `münchen.de` and `xn--mnchen-3ya.de` arrive here identical. Only the
 * fully-qualified trailing dot is left to remove.
 */
function normaliseHost(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * Only an exact leading `www.` when the rest still contains a dot. `www.com`
 * stays whole; `www2.` is an ordinary subdomain.
 */
function stripLeadingWww(host: string): string {
  if (host.startsWith("www.") && host.slice(4).includes(".")) {
    return host.slice(4);
  }
  return host;
}

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAMS.has(key) || TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Returns the registrable domain (eTLD+1) in punycode, or null when the host has
 * none — localhost, bare IPs, and any non-http(s) scheme.
 *
 * Guarantees that `ben.github.io` stays whole and `www.bbc.co.uk` reduces to
 * `bbc.co.uk`, because the Public Suffix List says so and counting dots does not.
 */
export function registrableDomain(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;

  // allowPrivateDomains matters more than it looks. tldts defaults to the ICANN
  // half of the Public Suffix List, where `github.io` is not a suffix — so
  // ben.github.io and someone-else.github.io would both reduce to "github.io"
  // and land in one meaningless group. The PRIVATE half is exactly the list of
  // "this is user content, treat each subdomain as its own site" registrations.
  return getDomain(normaliseHost(parsed.hostname), { allowPrivateDomains: true });
}

/**
 * Returns the grouping host: lowercase, trailing-dot stripped, leading `www.`
 * stripped the same way as `canonicalUrl`. Null when the URL is not http(s).
 *
 * Guarantees punycode (via `URL`) so `münchen.de` and `xn--mnchen-3ya.de` compare
 * equal, and that `www.github.com` and `github.com` are the same host.
 */
export function hostnameOf(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const host = stripLeadingWww(normaliseHost(parsed.hostname));
  return host === "" ? null : host;
}

/**
 * Normalises a user-typed host or site pattern the same way grouping hosts are
 * compared. Null when empty, whitespace-only, or not a host.
 *
 * Guarantees the same lowercase / punycode / trailing-dot / `www.` rules as
 * `hostnameOf`, so a pattern of `www.GitHub.com.` matches `github.com`.
 */
export function hostnameOfPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed === "") return null;
  return hostnameOf(`https://${trimmed}`);
}

/**
 * Returns a string that is equal for two URLs exactly when we consider them the
 * same page, or null for anything not http(s).
 *
 * Equal for: differing scheme/host case, a leading `www.`, a default port, a
 * trailing dot on the host, tracking parameters, query parameter order, and an
 * ordinary `#fragment`. Not equal for: differing paths (case included), any
 * unrecognised query parameter, and `#/`-style routes.
 */
export function canonicalUrl(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;

  const host = stripLeadingWww(normaliseHost(parsed.hostname));

  // `URL` drops :443 on https and :80 on http for us; whatever survives is meaningful.
  const port = parsed.port ? `:${parsed.port}` : "";

  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    if (isTrackingParam(key)) params.delete(key);
  }
  params.sort();
  const query = params.toString();

  const fragment = parsed.hash.startsWith("#/") ? parsed.hash : "";

  return `${parsed.protocol}//${host}${port}${parsed.pathname}${query ? `?${query}` : ""}${fragment}`;
}
