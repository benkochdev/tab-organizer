import { browser } from "wxt/browser";

/**
 * Preferences that outlive a session. Collapse-on-apply is a preference, not a
 * per-window fact, so it lives in `storage.local` rather than `storage.session`.
 */

const SETTINGS_KEY = "ui.settings";

export type UiSettings = {
  collapseNewGroups: boolean;
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  collapseNewGroups: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Missing or malformed storage is treated as the defaults. */
export async function loadUiSettings(): Promise<UiSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const value: unknown = stored[SETTINGS_KEY];

  if (!isRecord(value) || typeof value.collapseNewGroups !== "boolean") {
    return DEFAULT_UI_SETTINGS;
  }

  return { collapseNewGroups: value.collapseNewGroups };
}

export async function saveUiSettings(settings: UiSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}
