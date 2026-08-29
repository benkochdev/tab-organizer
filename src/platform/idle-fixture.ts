/** `npm run dev` startUrl whose lastAccessed we fake. Firefox cannot write it. */
export const IDLE_FIXTURE_URL = "https://example.net/old";

/** True for the Archive fixture tab, ignoring query/hash. */
export function isIdleFixtureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://example.net" && parsed.pathname === "/old";
  } catch {
    return false;
  }
}
