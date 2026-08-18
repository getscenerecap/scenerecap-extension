import { api, uploadBlob, getTokens, APP_URL } from "./lib/api.js";

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
      status.textContent = "Creating recording…";
      const { recording } = await api<{ recording: { id: string } }>("/v1/recordings", {
        method: "POST",
        body: {
          uploadId: mediaId,
          eventLogUploadId: eventsId,
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
