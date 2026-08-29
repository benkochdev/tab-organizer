import { defineConfig } from "wxt";
import { IDLE_FIXTURE_URL } from "./src/platform/idle-fixture";

export default defineConfig({
  // Source lives under src/, so WXT looks for src/entrypoints/ instead of ./entrypoints/.
  srcDir: "src",

  // publicDir is resolved against the project root, not srcDir, so it does not
  // follow the line above and has to be said out loud. Files in here are copied
  // to the extension root verbatim — that is what makes "icon.svg" in the
  // manifest resolve.
  publicDir: "src/public",

  // Auto-imports off, deliberately. WXT can make `browser`, React hooks and our own
  // helpers appear without an import statement. That is convenient and unreadable:
  // you open a file and cannot tell where a name came from. Every import is explicit.
  imports: false,

  modules: ["@wxt-dev/module-react"],

  // A fixture window so `npm run dev` exercises groups, duplicates, leftovers,
  // a host with no registrable domain, a cross-site Lisbon topic (D-035), and
  // one idle tab for Archive (lastAccessed is faked in the adapter; Firefox
  // will not let us write it on a real tab).
  webExt: {
    startUrls: [
      "https://github.com/wxt-dev/wxt",
      "https://github.com/wxt-dev/wxt",
      "https://github.com/facebook/react",
      "https://github.com/vitest-dev/vitest",
      "https://mail.google.com/mail",
      "https://docs.google.com/document/u/0/",
      "https://drive.google.com/drive",
      "https://example.com/page?utm_source=dev",
      "https://www.example.com/page",
      "https://news.ycombinator.com/",
      "https://stackoverflow.com/questions/1",
      "https://stackoverflow.com/questions/2",
      "http://localhost:3000/",
      "https://en.wikipedia.org/wiki/Lisbon",
      "https://en.wikivoyage.org/wiki/Lisbon",
      "https://www.britannica.com/place/Lisbon",
      IDLE_FIXTURE_URL,
    ],
  },

  // Explicit: WXT still defaults Firefox to MV2. Our design assumes MV3 —
  // non-persistent event page, and the tabGroups API we target.
  manifestVersion: 3,

  manifest: {
    name: "Tab Organizer",
    description: "Preview tab groups for the current window, then apply.",

    // One SVG for every size. Firefox renders SVG extension icons; Chrome does
    // not, which is a trade this Firefox-only extension can make (D-018).
    icons: {
      16: "icon.svg",
      32: "icon.svg",
      48: "icon.svg",
      96: "icon.svg",
      128: "icon.svg",
    },

    action: {
      default_icon: "icon.svg",
      default_title: "Tab Organizer",
    },

    // Alt+Shift+O is unclaimed in Firefox — Ctrl+Shift+O is the bookmarks
    // library. Rebindable under about:addons → gear → Manage Extension Shortcuts.
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+O" },
        description: "Open Tab Organizer",
      },
    },

    // "tabs" to read urls and titles, "storage" for the undo snapshot and settings,
    // "tabGroups" to title and colour a group (tabs.group() itself needs nothing).
    // Nothing else, ever — no host permissions, so the extension cannot read page content.
    permissions: ["tabs", "storage", "tabGroups"],

    browser_specific_settings: {
      gecko: {
        // AMO signs against this id, and changing it after the first signed
        // build makes Firefox treat the result as a different add-on. Fixed now,
        // while nothing has been signed yet.
        id: "tab-organizer@benk113.github.io",
        // tabGroups.update() (title, colour, collapsed) landed in Firefox 139.
        strict_min_version: "139.0",
        // Required by AMO for extensions new since 2025-11-03. "none" is a real,
        // enforced declaration, not a formality: we transmit nothing, anywhere.
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  },
});
