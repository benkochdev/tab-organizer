import type { Config, GroupProposal, TabInfo } from "./types";

/** Deterministic, locale-independent. `localeCompare` is neither. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byTabIndex(a: TabInfo, b: TabInfo): number {
  return a.index - b.index;
}

const PALETTE_SIZE = 9;

/**
 * Known display names. Anything not in here still uses the first label of the
 * domain, capitalised — "t.co" stays ugly on purpose.
 */
const SERVICE_LABELS: Readonly<Record<string, string>> = {
  "amazon.com": "Amazon",
  "apple.com": "Apple",
  "bbc.co.uk": "BBC",
  "github.com": "GitHub",
  "google.com": "Google",
  "linkedin.com": "LinkedIn",
  "microsoft.com": "Microsoft",
  "nytimes.com": "NYTimes",
  "reddit.com": "Reddit",
  "stackoverflow.com": "Stack Overflow",
  "wikipedia.org": "Wikipedia",
  "x.com": "X",
  "youtube.com": "YouTube",
};

const GOOGLE_HOST_PRODUCT: Readonly<Record<string, string>> = {
  "calendar.google.com": "calendar",
  "chat.google.com": "chat",
  "classroom.google.com": "classroom",
  "contacts.google.com": "contacts",
  "docs.google.com": "docs",
  "drive.google.com": "drive",
  "keep.google.com": "keep",
  "mail.google.com": "gmail",
  "maps.google.com": "maps",
  "meet.google.com": "meet",
  "news.google.com": "news",
  "photos.google.com": "photos",
  "translate.google.com": "translate",
};

const GOOGLE_PRODUCT_LABEL: Readonly<Record<string, string>> = {
  calendar: "Calendar",
  chat: "Chat",
  classroom: "Classroom",
  contacts: "Contacts",
  docs: "Docs",
  drive: "Drive",
  gmail: "Gmail",
  keep: "Keep",
  maps: "Maps",
  meet: "Meet",
  news: "News",
  photos: "Photos",
  search: "Search",
  sheets: "Sheets",
  slides: "Slides",
  translate: "Translate",
};

const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "are",
  "com",
  "for",
  "from",
  "google",
  "how",
  "http",
  "https",
  "new",
  "org",
  "the",
  "this",
  "that",
  "wiki",
  "wikipedia",
  "www",
  "you",
  "your",
]);

/**
 * Display name for a registrable domain.
 *
 * Guarantees a known service keeps its real capitalisation (github.com → GitHub);
 * anything else is the first label with a leading capital.
 */
export function labelForDomain(domain: string): string {
  const known = SERVICE_LABELS[domain];
  if (known !== undefined) return known;
  const head = domain.split(".")[0] ?? domain;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** Google product key, or null when this is not a recognised Google host. */
export function googleProduct(url: string): string | null {
  const host = hostOf(url);
  if (host === null) return null;

  if (host === "docs.google.com") {
    const path = pathOf(url);
    if (path.startsWith("/spreadsheets")) return "sheets";
    if (path.startsWith("/presentation")) return "slides";
    return "docs";
  }

  if (host === "google.com") return "search";

  return GOOGLE_HOST_PRODUCT[host] ?? null;
}

function titleTokens(title: string): string[] {
  const stripped = title.toLowerCase().replace(/\s*[-–—|:].*$/, "");
  const words = stripped.match(/[a-z0-9]{3,}/g) ?? [];
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const word of words) {
    if (TITLE_STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    tokens.push(word);
  }

  return tokens;
}

function ordered(tabs: readonly TabInfo[]): TabInfo[] {
  return [...tabs].sort(byTabIndex);
}

function proposal(
  key: string,
  label: string,
  tabs: readonly TabInfo[],
  reason: string,
): GroupProposal {
  const members = ordered(tabs);
  return {
    key,
    label,
    color: colorForKey(key),
    tabIds: members.map((tab) => tab.id),
    reason,
  };
}

function colorForKey(key: string): GroupProposal["color"] {
  const palette: GroupProposal["color"][] = [
    "blue",
    "cyan",
    "green",
    "grey",
    "orange",
    "pink",
    "purple",
    "red",
    "yellow",
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) >>> 0;
  }
  return palette[hash % PALETTE_SIZE] ?? "blue";
}

function splitGoogle(tabs: readonly TabInfo[], config: Config, domain: string): GroupProposal[] {
  const byProduct = new Map<string, TabInfo[]>();

  for (const tab of tabs) {
    const product = googleProduct(tab.url) ?? "other";
    const bucket = byProduct.get(product);
    if (bucket) bucket.push(tab);
    else byProduct.set(product, [tab]);
  }

  const peeled: GroupProposal[] = [];
  const leftover: TabInfo[] = [];

  for (const [product, members] of byProduct) {
    if (product !== "other" && members.length >= config.minGroupSize) {
      const label = GOOGLE_PRODUCT_LABEL[product] ?? capitalise(product);
      peeled.push(
        proposal(
          `domain:${domain}:${product}`,
          label,
          members,
          `${members.length} ${label} ${members.length === 1 ? "tab" : "tabs"}`,
        ),
      );
    } else {
      leftover.push(...members);
    }
  }

  if (leftover.length >= config.minGroupSize) {
    peeled.push(
      proposal(
        `domain:${domain}`,
        labelForDomain(domain),
        leftover,
        `${leftover.length} tabs from ${domain}`,
      ),
    );
  }

  peeled.sort((a, b) => b.tabIds.length - a.tabIds.length || compareStrings(a.key, b.key));

  // Site grouping stays the default: one product covering everyone, or one
  // product plus crumbs that cannot form a second group, is still "Google".
  if (peeled.length <= 1) {
    return [
      proposal(
        `domain:${domain}`,
        labelForDomain(domain),
        tabs,
        `${tabs.length} tabs from ${domain}`,
      ),
    ];
  }

  return peeled;
}

function splitByTitleTopics(
  tabs: readonly TabInfo[],
  config: Config,
  domain: string,
): GroupProposal[] {
  const site = labelForDomain(domain);
  let leftover = [...tabs];
  const peeled: GroupProposal[] = [];

  while (leftover.length >= config.minGroupSize) {
    const tokenTabs = new Map<string, TabInfo[]>();

    for (const tab of leftover) {
      for (const token of titleTokens(tab.title)) {
        const bucket = tokenTabs.get(token);
        if (bucket) bucket.push(tab);
        else tokenTabs.set(token, [tab]);
      }
    }

    let bestToken: string | null = null;
    let bestMembers: TabInfo[] = [];
    // A token that covers every leftover tab is the whole remaining pile, not a
    // mix — unless we already split once, in which case this remainder is itself
    // a topic (the toads left after peeling cake).
    const allowFullCover = peeled.length > 0;

    for (const [token, members] of tokenTabs) {
      if (members.length < config.minGroupSize) continue;
      if (members.length === leftover.length && !allowFullCover) continue;
      if (
        members.length > bestMembers.length ||
        (members.length === bestMembers.length &&
          bestToken !== null &&
          compareStrings(token, bestToken) < 0)
      ) {
        bestToken = token;
        bestMembers = members;
      }
    }

    if (bestToken === null) break;

    const taken = new Set(bestMembers.map((tab) => tab.id));
    peeled.push(
      proposal(
        `domain:${domain}:${bestToken}`,
        capitalise(bestToken),
        bestMembers,
        `${bestMembers.length} ${site} tabs about ${bestToken}`,
      ),
    );
    leftover = leftover.filter((tab) => !taken.has(tab.id));
  }

  if (leftover.length >= config.minGroupSize) {
    peeled.push(
      proposal(`domain:${domain}`, site, leftover, `${leftover.length} tabs from ${domain}`),
    );
  }

  // One topic covering everyone, or one topic plus crumbs, stays the site group.
  if (peeled.length <= 1) {
    return [proposal(`domain:${domain}`, site, tabs, `${tabs.length} tabs from ${domain}`)];
  }

  peeled.sort((a, b) => b.tabIds.length - a.tabIds.length || compareStrings(a.key, b.key));

  return peeled;
}

/**
 * Turns one domain bucket into one or more groups when the site mixes products
 * or article topics. Sites we do not know how to split are returned unchanged.
 *
 * Guarantees: never yields an empty group; never drops a tab that still meets
 * minGroupSize as a leftover parent; output is stable for equivalent input.
 */
export function splitMixedSite(
  domain: string,
  tabs: readonly TabInfo[],
  config: Config,
): { groups: GroupProposal[]; leftover: TabInfo[] } {
  const members = ordered(tabs);
  if (domain === "google.com") {
    const groups = splitGoogle(members, config, domain);
    const grouped = new Set(groups.flatMap((group) => group.tabIds));
    return {
      groups,
      leftover: members.filter((tab) => !grouped.has(tab.id)),
    };
  }

  if (domain === "wikipedia.org") {
    const groups = splitByTitleTopics(members, config, domain);
    const grouped = new Set(groups.flatMap((group) => group.tabIds));
    return {
      groups,
      leftover: members.filter((tab) => !grouped.has(tab.id)),
    };
  }

  return {
    groups: [
      proposal(
        `domain:${domain}`,
        labelForDomain(domain),
        members,
        `${members.length} tabs from ${domain}`,
      ),
    ],
    leftover: [],
  };
}
