/// <reference types="chrome" />
/**
 * Background service worker: orchestrates recording sessions.
 * - Creates offscreen document (MediaRecorder can't live in a SW)
 * - Injects the telemetry content script into the recorded tab
 * - Buffers telemetry events; hands everything to the review page on stop
 */
import { APP_URL } from "./lib/api.js";
import { getSettings, isBlockedHost } from "./lib/settings.js";

interface SessionState {
  recording: boolean;
  tabId: number | null;
  startedAt: number; // epoch ms when recording started
  mode: string;
  events: unknown[];
}

const state: SessionState = { recording: false, tabId: null, startedAt: 0, mode: "explain", events: [] };

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "MediaRecorder for screen recording must run in a document context",
    });
  }
}

async function startRecording(opts: { mode: string; mic: boolean }) {
  if (state.recording) return { ok: false, error: "Already recording" };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab" };
  // Never record restricted or sensitive pages, and never in incognito windows (§3.3 privacy)
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    return { ok: false, error: "This page can't be recorded" };
  }
  if (tab.incognito) {
    return { ok: false, error: "Recording is disabled in incognito windows" };
  }
  // User blocklist (§3.4): checked HERE, the single choke point, so the popup path and the keyboard
  // shortcut cannot disagree about which sites are off-limits.
  try {
    const { blockedDomains } = await getSettings();
    if (blockedDomains.length && isBlockedHost(new URL(tab.url).hostname, blockedDomains)) {
      return { ok: false, error: "This domain is on your never-record list (extension settings)." };
    }
  } catch { /* settings unreadable -> do not block */ }

  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });

  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ kind: "offscreen:start", streamId, mic: opts.mic })) as { ok: boolean; error?: string };
  if (!res?.ok) return { ok: false, error: res?.error ?? "Recorder failed to start" };

  state.recording = true;
  state.tabId = tab.id;
  state.startedAt = Date.now();
  state.mode = opts.mode;
  state.events = [];

  // environment event
  state.events.push({
    type: "environment", t: 0,
    browser: `Chrome ${/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "?"}`,
    os: navigator.platform, locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // Inject telemetry collector
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch {
    // page may not allow injection (e.g. web store) — recording still works, just fewer events
  }
  await chrome.action.setBadgeText({ text: "REC" });
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  return { ok: true };
}

async function stopRecording() {
  if (!state.recording) return { ok: false, error: "Not recording" };
  const res = (await chrome.runtime.sendMessage({ kind: "offscreen:stop" })) as { ok: boolean; blobUrl?: string; error?: string };
  state.recording = false;
  await chrome.action.setBadgeText({ text: "" });
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { kind: "telemetry:stop" }).catch(() => {});
  }
  if (!res?.ok || !res.blobUrl) return { ok: false, error: res?.error ?? "Recorder failed to stop" };

  // Stash session data for the review page
  const jsonl = state.events.map((e) => JSON.stringify(e)).join("\n");
  await chrome.storage.session.set({
    review: { blobUrl: res.blobUrl, eventsJsonl: jsonl, mode: state.mode, durationMs: Date.now() - state.startedAt },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg: { kind: string; [k: string]: unknown }, sender, sendResponse) => {
  (async () => {
    switch (msg.kind) {
      case "popup:start":
        sendResponse(await startRecording({ mode: String(msg.mode ?? "explain"), mic: Boolean(msg.mic) }));
        break;
      case "popup:stop":
        sendResponse(await stopRecording());
        break;
      case "popup:state":
        sendResponse({ recording: state.recording, mode: state.mode, startedAt: state.startedAt });
        break;
      case "telemetry:event": {
        if (state.recording && sender.tab?.id === state.tabId) {
          const ev = msg.event as { t?: number };
          ev.t = Date.now() - state.startedAt; // normalize to ms-from-start
          state.events.push(ev);
          if (state.events.length > 20000) state.events.shift(); // 5MB-ish cap guard
        }
        sendResponse({ ok: true });
        break;
      }
      case "auth:code": {
        // one-time code from app web page (§3.7)
        try {
          const { api, setTokens } = await import("./lib/api.js");
          const data = await api<{ accessToken: string; refreshToken: string }>("/v1/auth/extension-exchange", {
            method: "POST", body: { code: msg.code },
          });
          await setTokens(data);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : "exchange failed" });
        }
        break;
      }
      default:
        break;
    }
  })();
  return true; // async sendResponse
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-recording") {
    if (state.recording) await stopRecording();
    else {
      // The shortcut has no UI to pick a mode, so it uses the remembered defaults (§3.5).
      const s = await getSettings();
      await startRecording({ mode: s.defaultMode, mic: s.defaultMic });
    }
  }
});

// Track navigations of the recorded tab from the privileged side, and RE-INJECT the telemetry
// collector after full-page loads: a content script only lives as long as its document, so without
// this the event log goes silent after the first real navigation (seen on the first prod recording).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!state.recording || tabId !== state.tabId) return;
  if (changeInfo.url) {
    const url = new URL(changeInfo.url);
    // Mid-recording navigation onto a never-record domain stops the recording — the blocklist is a
    // promise about the domain, not about where the recording happened to start.
    void getSettings().then((s) => {
      if (s.blockedDomains.length && isBlockedHost(url.hostname, s.blockedDomains)) void stopRecording();
    }).catch(() => { /* settings unreadable -> keep recording */ });
    state.events.push({ type: "navigation", t: Date.now() - state.startedAt, url: url.pathname, title: tab.title?.slice(0, 200), spa: false });
  }
  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    // content.js guards against double-injection per document; "loading" catches early clicks,
    // "complete" is the fallback when the document wasn't ready yet.
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => { /* restricted page */ });
  }
});

chrome.tabs.onActivated.addListener(async (info) => {
  if (state.recording && state.tabId && info.tabId !== state.tabId) {
    state.events.push({ type: "tab_switch", t: Date.now() - state.startedAt });
  }
});

export {};
