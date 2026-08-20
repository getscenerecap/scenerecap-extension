/// <reference types="chrome" />
/** Microphone permission page. The offscreen document (where MediaRecorder lives) is invisible,
 *  so Chrome has no surface to show a mic permission prompt there and rejects getUserMedia
 *  outright. This visible page exists solely to obtain the extension-origin mic permission once;
 *  after that, the offscreen document's getUserMedia succeeds without a prompt. */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function state(): Promise<PermissionState> {
  try {
    const st = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return st.state;
  } catch {
    return "prompt";
  }
}

function show(kind: "ask" | "granted" | "denied") {
  $("ask").style.display = kind === "ask" ? "block" : "none";
  $("granted").style.display = kind === "granted" ? "block" : "none";
  $("denied").style.display = kind === "denied" ? "block" : "none";
}

async function request() {
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Only the permission grant matters; release the device immediately.
    mic.getTracks().forEach((t) => t.stop());
    show("granted");
  } catch {
    show((await state()) === "denied" ? "denied" : "ask");
  }
}

async function init() {
  const st = await state();
  if (st === "granted") {
    show("granted");
    return;
  }
  show(st === "denied" ? "denied" : "ask");
  if (st === "prompt") void request(); // surface the prompt right away; the button is the retry path
}

$("enable").onclick = () => void request();
$("reload").onclick = () => location.reload();
$("close").onclick = async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) await chrome.tabs.remove(tab.id);
};

void init();

export {};
