import { getSettings, saveSettings } from "./lib/settings.js";
import { APP_URL } from "./lib/api.js";

/** Options page (spec §3.5): blocklist, capture toggles, defaults. Saves on change — no Save button
 *  to forget to press for a page whose whole point is "I set this once and trust it". */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const blocklist = $("blocklist") as HTMLTextAreaElement;
const captureConsole = $("capture-console") as HTMLInputElement;
const defaultMode = $("default-mode") as HTMLSelectElement;
const defaultMic = $("default-mic") as HTMLInputElement;

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function flash() {
  const el = $("status");
  el.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

async function main() {
  ($("settings-link") as HTMLAnchorElement).href = `${APP_URL}/dashboard/settings`;
  const s = await getSettings();
  blocklist.value = s.blockedDomains.join("\n");
  captureConsole.checked = s.captureConsole;
  defaultMode.value = s.defaultMode;
  defaultMic.checked = s.defaultMic;

  blocklist.onchange = async () => {
    const domains = blocklist.value.split("\n").map((d) => d.trim()).filter(Boolean).slice(0, 500);
    await saveSettings({ blockedDomains: domains });
    flash();
  };
  captureConsole.onchange = async () => { await saveSettings({ captureConsole: captureConsole.checked }); flash(); };
  defaultMode.onchange = async () => { await saveSettings({ defaultMode: defaultMode.value }); flash(); };
  defaultMic.onchange = async () => { await saveSettings({ defaultMic: defaultMic.checked }); flash(); };
}

void main();
