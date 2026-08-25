import { api, getTokens, APP_URL } from "./lib/api.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Mic permission must be granted from a visible page (mic.html) — the offscreen document that
 *  actually records can't show a prompt, its getUserMedia just rejects. */
async function micGranted(): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return st.state === "granted";
  } catch {
    return false;
  }
}

async function render() {
  const { accessToken } = await getTokens();
  const state = (await chrome.runtime.sendMessage({ kind: "popup:state" })) as { recording: boolean; startedAt: number };
  // Pre-select the remembered mode (§3.5) — the select otherwise resets to "explain" every open.
  void import("./lib/settings.js").then(({ getSettings }) => getSettings().then((s) => {
    const sel = document.getElementById("mode") as HTMLSelectElement | null;
    if (sel && !state.recording) sel.value = s.defaultMode;
  })).catch(() => {});

  $("auth-row").textContent = "";
  if (accessToken) {
    try {
      const me = await api<{ user: { email: string } }>("/v1/me");
      $("auth-row").textContent = me.user.email;
    } catch {
      $("auth-row").innerHTML = `<a id="signin" href="#">Sign in</a>`;
    }
  } else {
    $("auth-row").innerHTML = `<a id="signin" href="#">Sign in to upload & analyze</a>`;
  }
  document.getElementById("signin")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `${APP_URL}/auth/extension` });
  });

  const micBox = $("mic") as HTMLInputElement;
  micBox.onchange = async () => {
    if (micBox.checked && !(await micGranted())) {
      micBox.checked = false;
      await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
    }
  };

  const btn = $("record") as HTMLButtonElement;
  if (state.recording) {
    btn.textContent = "■ Stop recording";
    btn.className = "btn stop";
    ($("hint") as HTMLElement).textContent = "Recording this tab…";
  } else {
    btn.textContent = "● Record this tab";
    btn.className = "btn start";
    ($("hint") as HTMLElement).textContent = "Silent recordings are fully supported.";
  }
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (state.recording) {
        const res = (await chrome.runtime.sendMessage({ kind: "popup:stop" })) as { ok: boolean; error?: string };
        if (!res.ok) throw new Error(res.error);
        window.close();
      } else {
        const mode = ($("mode") as HTMLSelectElement).value;
        // "default remembered" (§3.5): the next popup open and the keyboard shortcut follow suit.
        void import("./lib/settings.js").then(({ saveSettings }) => saveSettings({ defaultMode: mode })).catch(() => {});
        const mic = micBox.checked;
        if (mic && !(await micGranted())) {
          // Permission revoked since the box was ticked — re-run the grant flow instead of
          // silently recording without the mic the user asked for.
          await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
          throw new Error("Allow the microphone in the tab that opened, then record again.");
        }
        const res = (await chrome.runtime.sendMessage({ kind: "popup:start", mode, mic })) as { ok: boolean; error?: string };
        if (!res.ok) throw new Error(res.error);
        window.close();
      }
    } catch (e) {
      ($("hint") as HTMLElement).textContent = e instanceof Error ? e.message : "Failed";
      btn.disabled = false;
    }
  };
}

void render();
