import { api, uploadBlob, getTokens, APP_URL } from "./lib/api.js";
import { emptyEdits, hasEdits, toManifest, keptSeconds, type EditState } from "./redact.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface ReviewData { blobUrl: string; eventsJsonl: string; mode: string; durationMs: number }

async function main() {
  const { review } = (await chrome.storage.session.get("review")) as { review?: ReviewData };
  if (!review) {
    $("status").textContent = "No recording found. Record something first.";
    return;
  }
  // The blobUrl was minted in the offscreen document; fetch it from there via message is complex —
  // instead re-fetch it directly (blob: URLs are origin-scoped to the extension, so this works).
  const blob = await (await fetch(review.blobUrl)).blob();
  const video = $("preview") as HTMLVideoElement;
  video.src = URL.createObjectURL(blob);

  const durSec = Math.round(review.durationMs / 1000);
  $("meta").textContent = `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, "0")} · ${(blob.size / 1024 / 1024).toFixed(1)} MB · ${review.eventsJsonl.split("\n").filter(Boolean).length} events captured`;
  ($("mode") as HTMLSelectElement).value = review.mode;

  // ---- Redaction editor (spec §3.4): cut / blur / mute against the local preview. All edits stay
  // in this page until upload; the manifest rides along as a sidecar and the pipeline applies it.
  const edits: EditState = emptyEdits();
  const dur = Math.max(0.1, review.durationMs / 1000);
  let tool: "cut" | "blur" | "mute" | null = null;
  let pendingStart: number | null = null;
  let playhead = 0;
  const bar = $("bar");
  const frame = $("frame");
  const markBtn = $("mark") as HTMLButtonElement;
  const fmtT = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

  const renderEditor = () => {
    // timeline bands
    bar.querySelectorAll(".cut,.mute,.blur,.ph,.pending").forEach((n) => n.remove());
    const band = (cls: string, t0: number, t1: number) => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.left = `${(t0 / dur) * 100}%`;
      d.style.width = `${((t1 - t0) / dur) * 100}%`;
      bar.appendChild(d);
    };
    edits.cuts.forEach((c) => band("cut", c.t0, c.t1));
    edits.mutes.forEach((m) => band("mute", m.t0, m.t1));
    edits.blurs.forEach((b) => band("blur", b.t0, b.t1));
    if (pendingStart !== null) { const d = document.createElement("div"); d.className = "pending"; d.style.left = `${(pendingStart / dur) * 100}%`; bar.appendChild(d); }
    const ph = document.createElement("div"); ph.className = "ph"; ph.style.left = `${(playhead / dur) * 100}%`; bar.appendChild(ph);
    // meta line
    const keeps = edits.cuts.length ? ` · keeps ${fmtT(keptSeconds(edits.cuts, dur))}` : "";
    $("edit-meta").textContent = `${fmtT(playhead)} / ${fmtT(dur)}${keeps}`;
    // mark button
    markBtn.hidden = !(tool === "cut" || tool === "mute");
    markBtn.textContent = pendingStart === null ? `Mark ${tool} start at playhead` : `Mark ${tool} end at playhead`;
    // frame overlays: blurs visible at the playhead
    frame.querySelectorAll(".blur-box").forEach((n) => n.remove());
    frame.classList.toggle("blurtool", tool === "blur");
    video.controls = tool !== "blur";
    edits.blurs.forEach((b) => {
      if (playhead < b.t0 || playhead > b.t1) return;
      const d = document.createElement("div");
      d.className = "blur-box";
      d.style.left = `${b.x * 100}%`; d.style.top = `${b.y * 100}%`; d.style.width = `${b.w * 100}%`; d.style.height = `${b.h * 100}%`;
      frame.appendChild(d);
    });
    // list
    const list = $("edit-list");
    list.innerHTML = "";
    const row = (cls: string, label: string, onRemove: () => void) => {
      const li = document.createElement("li"); li.className = cls;
      const span = document.createElement("span"); span.textContent = label;
      const btn = document.createElement("button"); btn.textContent = "Remove"; btn.onclick = () => { onRemove(); renderEditor(); };
      li.append(span, btn); list.appendChild(li);
    };
    edits.cuts.forEach((c, i) => row("cut", `Cut ${fmtT(c.t0)} – ${fmtT(c.t1)}`, () => edits.cuts.splice(i, 1)));
    edits.blurs.forEach((b, i) => row("blur", `Blur ${fmtT(b.t0)} – ${fmtT(b.t1)}`, () => edits.blurs.splice(i, 1)));
    edits.mutes.forEach((m, i) => row("mute", `Mute ${fmtT(m.t0)} – ${fmtT(m.t1)}`, () => edits.mutes.splice(i, 1)));
  };

  for (const t of ["cut", "blur", "mute"] as const) {
    $(`tool-${t}`).onclick = () => {
      tool = tool === t ? null : t;
      pendingStart = null;
      for (const u of ["cut", "blur", "mute"]) $(`tool-${u}`).setAttribute("aria-pressed", String(tool === u));
      renderEditor();
    };
  }
  bar.onpointerdown = (e) => {
    const r = bar.getBoundingClientRect();
    playhead = Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
    video.currentTime = playhead;
    renderEditor();
  };
  video.ontimeupdate = () => { playhead = video.currentTime; renderEditor(); };
  markBtn.onclick = () => {
    if (pendingStart === null) { pendingStart = playhead; renderEditor(); return; }
    const t0 = Math.min(pendingStart, playhead), t1 = Math.max(pendingStart, playhead);
    pendingStart = null;
    if (t1 - t0 >= 0.1) (tool === "cut" ? edits.cuts : edits.mutes).push({ t0, t1 });
    renderEditor();
  };
  // blur drawing (normalised against the frame box — it shares the video's aspect, so box == frame)
  let draft: { x: number; y: number } | null = null;
  let draftEl: HTMLDivElement | null = null;
  const norm = (e: PointerEvent) => {
    const r = frame.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  frame.onpointerdown = (e) => {
    if (tool !== "blur") return;
    e.preventDefault();
    frame.setPointerCapture(e.pointerId);
    draft = norm(e);
    draftEl = document.createElement("div"); draftEl.className = "blur-draft"; frame.appendChild(draftEl);
  };
  frame.onpointermove = (e) => {
    if (!draft || !draftEl) return;
    const p = norm(e);
    Object.assign(draftEl.style, { left: `${Math.min(draft.x, p.x) * 100}%`, top: `${Math.min(draft.y, p.y) * 100}%`, width: `${Math.abs(p.x - draft.x) * 100}%`, height: `${Math.abs(p.y - draft.y) * 100}%` });
  };
  frame.onpointerup = (e) => {
    if (!draft) return;
    const p = norm(e);
    const x = Math.min(draft.x, p.x), y = Math.min(draft.y, p.y), w = Math.abs(p.x - draft.x), h = Math.abs(p.y - draft.y);
    draft = null; draftEl?.remove(); draftEl = null;
    if (w < 0.01 || h < 0.01) return;
    const t0 = Math.max(0, Math.min(playhead, dur - 0.1));
    edits.blurs.push({ x, y, w, h, t0, t1: Math.min(dur, t0 + 5) });
    renderEditor();
  };
  renderEditor();

  $("save").onclick = () => {
    const a = document.createElement("a");
    a.href = video.src;
    a.download = `scenerecap-${Date.now()}.webm`;
    a.click();
  };

  // Upload runs as a function so it can be triggered by the button OR resumed automatically once the
  // sign-in hand-off lands (the auth/extension page writes tokens into chrome.storage.local).
  let uploading = false;
  let wantedUpload = false;
  const doUpload = async () => {
    if (uploading) return;
    const btn = $("upload") as HTMLButtonElement;
    const status = $("status");
    const { accessToken } = await getTokens();
    if (!accessToken) {
      wantedUpload = true;
      status.innerHTML = `Sign in to upload — <a href="${APP_URL}/auth/extension" target="_blank">open sign-in</a>. This page will continue automatically once you're signed in.`;
      return;
    }
    uploading = true;
    btn.disabled = true;
    try {
      status.textContent = "Uploading video…";
      const mediaId = await uploadBlob(blob, "recording.webm", "video/webm", "media");
      status.textContent = "Uploading activity log…";
      const eventsId = await uploadBlob(new Blob([review.eventsJsonl], { type: "application/jsonl" }), "events.jsonl", "application/jsonl", "eventlog");
      // Redaction sidecar (spec §3.4): only when the user actually edited something.
      let redactionId: string | undefined;
      const manifest = toManifest(edits, dur);
      if (hasEdits(edits) && !manifest) throw new Error("Your cuts remove the whole recording — leave something to upload, or delete it instead.");
      if (manifest) {
        status.textContent = "Uploading redactions…";
        redactionId = await uploadBlob(new Blob([JSON.stringify(manifest)], { type: "application/json" }), "redaction.json", "application/json", "redaction_manifest");
      }
      status.textContent = "Creating recording…";
      const { recording } = await api<{ recording: { id: string } }>("/v1/recordings", {
        method: "POST",
        body: {
          uploadId: mediaId,
          eventLogUploadId: eventsId,
          redactionUploadId: redactionId,
          title: ($("title-input") as HTMLInputElement).value || "Untitled recording",
          mode: ($("mode") as HTMLSelectElement).value,
          durationSec: durSec,
          sourceMeta: { source: "extension", version: chrome.runtime.getManifest().version },
        },
      });
      status.innerHTML = `Processing started ✓ — <a href="${APP_URL}/dashboard/r/${recording.id}" target="_blank">open in SceneRecap</a>`;
      await chrome.storage.session.remove("review");
      // Take the user to the recording; the library shows live progress until it's ready.
      await chrome.tabs.create({ url: `${APP_URL}/dashboard/r/${recording.id}` });
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Upload failed";
      btn.disabled = false;
      uploading = false;
    }
  };
  $("upload").onclick = () => void doUpload();

  // Auto-resume: when the sign-in tab hands tokens to the extension, pick up the pending upload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.accessToken?.newValue && wantedUpload && !uploading) {
      wantedUpload = false;
      void doUpload();
    }
  });
}

void main();
