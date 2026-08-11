/** Injected only on the Retrace app's /auth/extension page: picks up the one-time
 *  code the page renders and completes the token exchange automatically. */
(() => {
  const tryConnect = async () => {
    const el = document.querySelector("[data-retrace-ext-code]");
    const code = el?.getAttribute("data-retrace-ext-code");
    if (!code) return false;
    const res = (await chrome.runtime.sendMessage({ kind: "auth:code", code })) as { ok: boolean };
    el?.setAttribute("data-retrace-ext-status", res?.ok ? "connected" : "error");
    return true;
  };
  const iv = setInterval(async () => {
    if (await tryConnect()) clearInterval(iv);
  }, 500);
  setTimeout(() => clearInterval(iv), 60_000);
})();

export {};
