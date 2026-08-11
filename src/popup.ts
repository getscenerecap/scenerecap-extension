import { api, getTokens, APP_URL } from "./lib/api.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const { accessToken } = await getTokens();
  const state = (await chrome.runtime.sendMessage({ kind: "popup:state" })) as { recording: boolean; startedAt: number };

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
        const mic = ($("mic") as HTMLInputElement).checked;
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
