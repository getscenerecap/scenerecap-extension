/**
 * User settings (spec §3.5 options page, §3.4 site blocklist). chrome.storage.local under one key —
 * NOT the token keys, so clearTokens() on sign-out never wipes preferences. Every reader falls back
 * to defaults, so a missing/partial object (fresh install, older version) is never an error.
 */

export interface Settings {
  /** "never allow recording on these domains" — matched against the tab's hostname and its parents. */
  blockedDomains: string[];
  /** Console/network error capture in Bug Report telemetry (on by default per §3.3). */
  captureConsole: boolean;
  /** Remembered defaults for the popup and the keyboard shortcut. */
  defaultMode: string;
  defaultMic: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  blockedDomains: [],
  captureConsole: true,
  defaultMode: "explain",
  defaultMic: false,
};

export async function getSettings(): Promise<Settings> {
  try {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings?: Partial<Settings> };
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
}

/**
 * True when `hostname` is covered by a blocklist entry. An entry blocks itself and every subdomain
 * ("bank.com" blocks "app.bank.com") — that is what "never record on this domain" means to the
 * person typing it; requiring them to enumerate subdomains would make the blocklist a fig leaf.
 */
export function isBlockedHost(hostname: string, blockedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return blockedDomains.some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (!d) return false;
    return host === d || host.endsWith(`.${d}`);
  });
}
