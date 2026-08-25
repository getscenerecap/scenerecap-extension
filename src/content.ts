/**
 * Telemetry content script (§3.3). STRICT privacy rules:
 * - never reads input values; password/cc fields emit only sensitive_field_interaction
 * - keyboard: modifier combos + special keys only, NEVER plaintext typing
 * - URLs: path only (query stripped)
 */
(async () => {
  if ((window as unknown as { __scenerecapTelemetry?: boolean }).__scenerecapTelemetry) return;
  (window as unknown as { __scenerecapTelemetry?: boolean }).__scenerecapTelemetry = true;

  let active = true;
  const send = (event: Record<string, unknown>) => {
    if (!active) return;
    try {
      chrome.runtime.sendMessage({ kind: "telemetry:event", event }).catch(() => {});
    } catch { /* extension reloaded */ }
  };

  const SENSITIVE_INPUT = /password|creditcard|cardnumber|cvv|cvc|ssn/i;

  function describeTarget(el: Element | null): Record<string, unknown> | undefined {
    if (!el) return undefined;
    const he = el as HTMLElement;
    const name =
      he.getAttribute("aria-label") ??
      (he.tagName === "INPUT" || he.tagName === "TEXTAREA"
        ? (he.getAttribute("placeholder") ?? he.getAttribute("name") ?? "")
        : (he.innerText ?? he.getAttribute("title") ?? "")).trim().slice(0, 80);
    const rect = he.getBoundingClientRect();
    return {
      role: he.getAttribute("role") ?? undefined,
      name: name || undefined,
      tag: he.tagName.toLowerCase(),
      box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    };
  }

  function isSensitive(el: Element | null): boolean {
    if (!el) return false;
    const input = el.closest("input");
    if (!input) return false;
    const type = input.getAttribute("type") ?? "";
    const ac = input.getAttribute("autocomplete") ?? "";
    return type === "password" || SENSITIVE_INPUT.test(type + ac + (input.getAttribute("name") ?? ""));
  }

  // ---- pointer ----
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as Element | null;
      if (isSensitive(target)) {
        send({ type: "sensitive_field_interaction" });
        return;
      }
      send({
        type: "click",
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
        target: describeTarget(target),
      });
    },
    { capture: true }
  );

  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollAcc = 0;
  window.addEventListener(
    "scroll",
    () => {
      scrollAcc += 1;
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        send({ type: "scroll", dy: scrollAcc * 100 });
        scrollAcc = 0;
        scrollTimer = null;
      }, 500);
    },
    { passive: true }
  );

  // ---- keyboard: combos only ----
  document.addEventListener(
    "keydown",
    (e) => {
      if (isSensitive(e.target as Element)) return;
      const mods = [e.metaKey && "Cmd", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
      const special = ["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      if (mods.length && e.key.length === 1) {
        send({ type: "key_combo", combo: [...mods, e.key.toUpperCase()].join("+") });
      } else if (special.includes(e.key) && (mods.length || ["Enter", "Escape", "Tab"].includes(e.key))) {
        send({ type: "key_combo", combo: [...mods, e.key].join("+") });
      }
      // plain typing: never captured
    },
    { capture: true }
  );

  // ---- SPA navigation ----
  const emitNav = (spa: boolean) => {
    send({ type: "navigation", url: location.pathname, title: document.title.slice(0, 200), spa });
    emitPageContext();
  };
  const origPush = history.pushState.bind(history);
  history.pushState = (...args) => {
    origPush(...(args as Parameters<typeof history.pushState>));
    emitNav(true);
  };
  window.addEventListener("popstate", () => emitNav(true));

  // ---- page context (every 10s + on nav) ----
  function emitPageContext() {
    const h1 = document.querySelector("h1");
    const main = document.querySelector("main, [role=main]");
    send({
      type: "page_context",
      title: document.title.slice(0, 200),
      h1: h1?.textContent?.trim().slice(0, 200) || undefined,
      landmarkText: (main?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || undefined,
    });
  }
  const ctxInterval = setInterval(emitPageContext, 10_000);
  emitPageContext();

  // ---- console + network errors (page-world hook via event bridge) ----
  // Gated on the user's capture toggle (§3.3: opt-in, on by default). Read once at injection:
  // a mid-recording settings change applies from the next recording, which is the understandable
  // behaviour — a toggle that half-applies to a recording in flight is not.
  let captureConsole = true;
  try {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings?: { captureConsole?: boolean } };
    if (settings?.captureConsole === false) captureConsole = false;
  } catch { /* storage unavailable (tests stub chrome) -> default on */ }

  const seenConsole = new Set<string>();
  const script = document.createElement("script");
  script.textContent = `(${(() => {
    const post = (detail: unknown) => window.dispatchEvent(new CustomEvent("__scenerecap_evt", { detail }));
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      try { post({ type: "console", level: "error", message: args.map((a) => String(a)).join(" ").slice(0, 2000) }); } catch {}
      origError(...args);
    };
    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      try { post({ type: "console", level: "warn", message: args.map((a) => String(a)).join(" ").slice(0, 2000) }); } catch {}
      origWarn(...args);
    };
    window.addEventListener("error", (e) => post({ type: "console", level: "error", message: String((e as ErrorEvent).message).slice(0, 2000) }));
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const started = performance.now();
      const res = await origFetch(...args);
      if (!res.ok && res.status >= 400) {
        try {
          const u = new URL(typeof args[0] === "string" ? args[0] : (args[0] as Request).url, location.href);
          post({ type: "network_error", method: ((args[1]?.method ?? (args[0] as Request)?.method) || "GET").toUpperCase().slice(0, 8), path: u.pathname.slice(0, 300), status: res.status, durationMs: Math.round(performance.now() - started) });
        } catch {}
      }
      return res;
    };
  }).toString()})()`;
  document.documentElement.appendChild(script);
  script.remove();

  window.addEventListener("__scenerecap_evt", ((e: CustomEvent) => {
    if (!captureConsole) return;
    const d = e.detail as { type: string; message?: string };
    if (d.type === "console") {
      const key = (d.message ?? "").slice(0, 100);
      if (seenConsole.has(key)) return; // dedupe
      seenConsole.add(key);
    }
    send(d as Record<string, unknown>);
  }) as EventListener);

  chrome.runtime.onMessage.addListener((msg: { kind: string }) => {
    if (msg.kind === "telemetry:stop") {
      active = false;
      clearInterval(ctxInterval);
    }
  });
})();
